# Hermes

Not yet covered by `agent-bus install`: the plugin is copied by hand.

```sh
scp -r packages/hermes-plugin/message-bus HOST:~/.hermes/plugins/
ssh HOST 'hermes plugins enable message-bus'
```

Then in the Hermes config:

```yaml
plugins:
  entries:
    message-bus:
      allow_gateway_injection: true
      settings:
        url: http://BUS-HOST:7800
        name: zeki                       # joins by name, not folder
        session_key: agent:main:discord:group:<chat_id>:<user_id>   # the session that receives messages
```

and `hermes gateway restart` (it waits for running turns).

What to expect: the agent joins by name; messages for an idle session start a turn; messages that arrive while it is
busy are held and handed over together as one message when the turn ends (Hermes would otherwise queue each as its
own turn and drop the rest after 32). The plugin has its own copy of the tool texts and does not have the GPU
schedule actions yet.

Tested by use (zeki, since 1 Nov); updated on 11 Nov to the version with agent tokens.
