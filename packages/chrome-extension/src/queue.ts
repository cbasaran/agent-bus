import {
  ANNOUNCEMENTS_CHANNEL_ID,
  formatInboundGroupChatBatch,
  isAgentMentioned,
  type BusMessage,
  type ChannelInfo,
  type ChannelInvite,
  type FileAttachment,
  type InboundEnvelopeItem,
} from "@agent-bus/protocol";
import type { RelayMode } from "./types";

export const DEFAULT_MAX_PASSIVE_ANNOUNCEMENTS = 15;

export interface SmartRelayQueueOptions {
  agentId: string;
  mode?: RelayMode;
  maxPassiveAnnouncements?: number;
  joinedChannelIds?: Iterable<string>;
}

export interface DrainedBatchResult {
  promptText: string;
  attachments: FileAttachment[];
  messageCount: number;
  inviteCount: number;
}

export type EnqueueDisposition = "triggering" | "passive" | "ignored";

function lookupFromMapOrRecord<V>(
  source: ReadonlyMap<string, V> | Record<string, V> | undefined,
  key: string
): V | undefined {
  if (!source) return undefined;
  if (source instanceof Map) {
    return source.get(key);
  }
  return (source as Record<string, V>)[key];
}

export class SmartRelayQueue {
  public readonly agentId: string;
  public mode: RelayMode;
  public isGenerating = false;
  public cooldownUntil = 0;

  private readonly maxPassiveAnnouncements: number;
  private readonly seenMessageIds = new Set<string>();
  private readonly seenInviteIds = new Set<string>();
  private readonly knownChannels = new Map<string, ChannelInfo>();
  private readonly explicitJoinedChannels = new Set<string>();

  private triggeringMessages: BusMessage[] = [];
  private passiveAnnouncements: BusMessage[] = [];
  private pendingInvites: ChannelInvite[] = [];

  constructor(optionsOrAgentId: SmartRelayQueueOptions | string, mode: RelayMode = "smart-auto") {
    if (typeof optionsOrAgentId === "string") {
      this.agentId = optionsOrAgentId;
      this.mode = mode;
      this.maxPassiveAnnouncements = DEFAULT_MAX_PASSIVE_ANNOUNCEMENTS;
    } else {
      this.agentId = optionsOrAgentId.agentId;
      this.mode = optionsOrAgentId.mode ?? mode;
      this.maxPassiveAnnouncements =
        optionsOrAgentId.maxPassiveAnnouncements ?? DEFAULT_MAX_PASSIVE_ANNOUNCEMENTS;
      if (optionsOrAgentId.joinedChannelIds) {
        for (const chId of optionsOrAgentId.joinedChannelIds) {
          this.explicitJoinedChannels.add(chId);
        }
      }
    }
  }

  public getMode(): RelayMode {
    return this.mode;
  }

  public setMode(nextMode: RelayMode): void {
    const prevMode = this.mode;
    this.mode = nextMode;

    // Switching into all-auto promotes buffered passive announcements into triggering items
    if (nextMode === "all-auto" && prevMode !== "all-auto" && this.passiveAnnouncements.length > 0) {
      const merged = [...this.passiveAnnouncements, ...this.triggeringMessages];
      merged.sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.createdAt - b.createdAt));
      this.triggeringMessages = merged;
      this.passiveAnnouncements = [];
    }
  }

  public setGenerating(generating: boolean): void {
    this.isGenerating = generating;
  }

  public setCooldownUntil(untilMs: number): void {
    this.cooldownUntil = untilMs;
  }

  public applyCooldown(durationMs: number, now = Date.now()): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, now + Math.max(0, durationMs));
  }

  public updateChannels(channels: Iterable<ChannelInfo>): void {
    for (const ch of channels) {
      this.upsertChannel(ch);
    }
  }

  public upsertChannel(channel: ChannelInfo): void {
    this.knownChannels.set(channel.id, channel);
    const lowerSelf = this.agentId.toLowerCase();
    const selfMember = channel.members.find((m) => m.agentId.toLowerCase() === lowerSelf);
    if (selfMember?.state === "active") {
      this.explicitJoinedChannels.add(channel.id);
    } else if (selfMember) {
      this.explicitJoinedChannels.delete(channel.id);
    }
  }

  public get triggeringCount(): number {
    return this.triggeringMessages.length;
  }

  public get inviteCount(): number {
    return this.pendingInvites.length;
  }

  public get passiveCount(): number {
    return this.passiveAnnouncements.length;
  }

  public get totalQueuedCount(): number {
    return this.triggeringMessages.length + this.pendingInvites.length;
  }

  public hasTriggeringItems(): boolean {
    return this.triggeringMessages.length + this.pendingInvites.length >= 1;
  }

  public hasAnyItems(): boolean {
    return (
      this.triggeringMessages.length > 0 ||
      this.pendingInvites.length > 0 ||
      this.passiveAnnouncements.length > 0
    );
  }

  private isJoinedTopicChannel(channelId: string, channel?: ChannelInfo): boolean {
    if (this.explicitJoinedChannels.has(channelId)) {
      return true;
    }
    const resolved = channel ?? this.knownChannels.get(channelId);
    if (!resolved) {
      // Without explicit channel membership info, messages delivered to the agent's inbox/WS
      // for a non-announcements channel belong to an accessible/joined channel.
      return true;
    }
    if (resolved.members.length === 0) {
      return true;
    }
    const lowerSelf = this.agentId.toLowerCase();
    return resolved.members.some(
      (member) => member.agentId.toLowerCase() === lowerSelf && member.state === "active"
    );
  }

  private isAccessiblePrivateChannel(channelId: string, channel?: ChannelInfo): boolean {
    const resolved = channel ?? this.knownChannels.get(channelId);
    if (!resolved || resolved.members.length === 0) {
      return true;
    }
    const lowerSelf = this.agentId.toLowerCase();
    return resolved.members.some(
      (member) =>
        member.agentId.toLowerCase() === lowerSelf &&
        (member.state === "active" || member.state === "invited")
    );
  }

  public enqueueMessage(message: BusMessage, channel?: ChannelInfo): EnqueueDisposition {
    if (!message.id || this.seenMessageIds.has(message.id)) {
      return "ignored";
    }
    if (message.senderId.toLowerCase() === this.agentId.toLowerCase()) {
      this.seenMessageIds.add(message.id);
      return "ignored";
    }

    if (channel) {
      this.upsertChannel(channel);
    }
    const resolvedChannel = channel ?? this.knownChannels.get(message.channelId);

    const isAnnouncements =
      message.channelId === ANNOUNCEMENTS_CHANNEL_ID || resolvedChannel?.type === "public";

    if (!isAnnouncements && resolvedChannel) {
      if (
        resolvedChannel.type === "topic" &&
        !this.isJoinedTopicChannel(message.channelId, resolvedChannel)
      ) {
        return "ignored";
      }
      if (
        resolvedChannel.type === "private" &&
        !this.isAccessiblePrivateChannel(message.channelId, resolvedChannel)
      ) {
        return "ignored";
      }
    }

    this.seenMessageIds.add(message.id);

    if (this.mode === "all-auto") {
      this.triggeringMessages.push(message);
      return "triggering";
    }

    // Both "smart-auto" and "manual-pause" classify announcements by @mention vs passive context
    if (isAnnouncements) {
      if (isAgentMentioned(message.mentions, this.agentId)) {
        this.triggeringMessages.push(message);
        return "triggering";
      }
      this.pushPassiveAnnouncement(message);
      return "passive";
    }

    // Private channel or joined topic channel message -> triggering
    this.triggeringMessages.push(message);
    return "triggering";
  }

  private pushPassiveAnnouncement(message: BusMessage): void {
    if (this.maxPassiveAnnouncements <= 0) return;
    this.passiveAnnouncements.push(message);
    if (this.passiveAnnouncements.length > this.maxPassiveAnnouncements) {
      const overflow = this.passiveAnnouncements.length - this.maxPassiveAnnouncements;
      this.passiveAnnouncements.splice(0, overflow);
    }
  }

  public enqueueInvite(invite: ChannelInvite): boolean {
    if (!invite.id || this.seenInviteIds.has(invite.id)) {
      return false;
    }
    if (invite.state !== "pending") {
      return false;
    }
    const selfLower = this.agentId.toLowerCase();
    if (invite.fromAgentId.toLowerCase() === selfLower) {
      this.seenInviteIds.add(invite.id);
      return false;
    }
    if (invite.toAgentId && invite.toAgentId.toLowerCase() !== selfLower) {
      return false;
    }

    this.seenInviteIds.add(invite.id);
    this.pendingInvites.push(invite);
    return true;
  }

  public removeInviteByChannel(channelId: string): void {
    this.pendingInvites = this.pendingInvites.filter((inv) => inv.channelId !== channelId);
  }

  public canAutoDispatch(now = Date.now()): boolean {
    if (this.mode === "manual-pause") {
      return false;
    }
    if (this.isGenerating) {
      return false;
    }
    if (now < this.cooldownUntil) {
      return false;
    }
    return this.hasTriggeringItems();
  }

  public peekPendingAttachments(includePassiveFallback = false): FileAttachment[] {
    const sourceMessages =
      this.triggeringMessages.length > 0 || !includePassiveFallback
        ? this.triggeringMessages
        : this.passiveAnnouncements;

    const attachments: FileAttachment[] = [];
    const seenIds = new Set<string>();
    for (const msg of sourceMessages) {
      for (const att of msg.attachments) {
        if (!seenIds.has(att.id)) {
          seenIds.add(att.id);
          attachments.push(att);
        }
      }
    }
    return attachments;
  }

  public drainBatch(
    channelsMap?: ReadonlyMap<string, ChannelInfo> | Record<string, ChannelInfo>,
    inlinedFilesMap?: ReadonlyMap<string, string> | Record<string, string>
  ): DrainedBatchResult {
    let triggering = this.triggeringMessages;
    let passive = this.passiveAnnouncements;
    const invites = this.pendingInvites;

    if (triggering.length === 0 && invites.length === 0 && passive.length === 0) {
      return {
        promptText: "",
        attachments: [],
        messageCount: 0,
        inviteCount: 0,
      };
    }

    // If manually draining when only passive context exists, surface them as the batch messages
    if (triggering.length === 0 && invites.length === 0 && passive.length > 0) {
      triggering = passive;
      passive = [];
    }

    this.triggeringMessages = [];
    this.passiveAnnouncements = [];
    this.pendingInvites = [];

    const attachments: FileAttachment[] = [];
    const seenAttachmentIds = new Set<string>();

    const envelopeItems: InboundEnvelopeItem[] = triggering.map((msg) => {
      const channel =
        lookupFromMapOrRecord(channelsMap, msg.channelId) ?? this.knownChannels.get(msg.channelId);

      let inlinedFiles: Record<string, string> | undefined;
      for (const att of msg.attachments) {
        if (!seenAttachmentIds.has(att.id)) {
          seenAttachmentIds.add(att.id);
          attachments.push(att);
        }
        const preview = lookupFromMapOrRecord(inlinedFilesMap, att.id);
        if (preview !== undefined) {
          inlinedFiles ??= {};
          inlinedFiles[att.id] = preview;
        }
      }

      return {
        message: msg,
        channel,
        inlinedFiles,
      };
    });

    const promptText = formatInboundGroupChatBatch({
      agentId: this.agentId,
      triggeringMessages: envelopeItems,
      invites,
      passiveAnnouncements: passive,
    });

    return {
      promptText,
      attachments,
      messageCount: triggering.length,
      inviteCount: invites.length,
    };
  }

  public flush(
    force = true,
    channelsMap?: ReadonlyMap<string, ChannelInfo> | Record<string, ChannelInfo>,
    inlinedFilesMap?: ReadonlyMap<string, string> | Record<string, string>,
    now = Date.now()
  ): DrainedBatchResult | null {
    if (!force && !this.canAutoDispatch(now)) {
      return null;
    }
    if (force ? !this.hasAnyItems() : !this.hasTriggeringItems()) {
      return null;
    }
    return this.drainBatch(channelsMap, inlinedFilesMap);
  }

  public clear(): void {
    this.triggeringMessages = [];
    this.passiveAnnouncements = [];
    this.pendingInvites = [];
  }
}
