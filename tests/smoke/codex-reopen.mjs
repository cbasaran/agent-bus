// macOS integration smoke: bun tests/smoke/codex-reopen.mjs
// A private CODEX_HOME, a loopback bus and a loopback mock model. No real chat, hooks or credentials.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createBusServer } from "../../packages/server/src/server.ts";

const cli = process.env.CODEX_APP_RUNTIME_CLI_PATH || Bun.which("codex");
assert.equal(process.platform,"darwin");
const dir = mkdtempSync(path.join(tmpdir(),"mb-reopen-"));
const home = path.join(dir,"config"), project = path.join(dir,"work"), plugin = path.join(dir,"market/plugins/message-bus");
mkdirSync(home); mkdirSync(project);
const bus = createBusServer({host:"127.0.0.1",port:0,dataDir:path.join(dir,"bus"),humans:["tester"]});
let requests=0, delivered=false;
const mock=createServer((req,res)=>{let body="";req.on("data",c=>body+=c);req.on("end",()=>{
  if (!req.url.includes("/responses")) {res.writeHead(404);res.end();return;}
  requests++; delivered ||= body.includes("reopen smoke delivery");
  res.writeHead(200,{"content-type":"text/event-stream"});
  res.end('data: {"type":"response.created","response":{"id":"resp_test","status":"in_progress"}}\n\ndata: {"type":"response.completed","response":{"id":"resp_test","status":"completed","output":[]}}\n\n');
})});
mock.listen(0,"127.0.0.1");await once(mock,"listening");
const wait=async fn=>{for(let i=0;i<250;i++){const r=await fn();if(r)return r;await Bun.sleep(100);}throw Error("timeout: "+fn);};
const participant=async()=> (await(await fetch(bus.url+"/api/state")).json()).participants.find(p=>p.id==="work");
async function app() {
  const p=spawn(cli,["app-server","--stdio"],{env:{PATH:process.env.PATH,CODEX_HOME:home},cwd:project,stdio:["pipe","pipe","ignore"]});
  let n=0;const pending=new Map(), started=[], completed=[];
  const send=m=>p.stdin.write(JSON.stringify(m)+"\n");
  const rpc=(method,params)=>new Promise((ok,no)=>{const id=++n;pending.set(id,[ok,no]);send({id,method,params});});
  createInterface({input:p.stdout}).on("line",line=>{const m=JSON.parse(line);
    if(pending.has(m.id)){const [ok,no]=pending.get(m.id);pending.delete(m.id);m.error?no(Error(m.error.message)):ok(m.result);}
    if(m.method==="turn/started") started.push(m.params.threadId);
    if(m.method==="turn/completed") completed.push(m.params.threadId);
  });
  p.on("exit",()=>{for(const [,no] of pending.values())no(Error("app-server exited"));pending.clear();});
  await rpc("initialize",{clientInfo:{name:"reopen-smoke",version:"1"},capabilities:{experimentalApi:true}});send({method:"initialized"});
  return {rpc,started,completed,stop:async()=>{if(p.exitCode!==null||p.signalCode)return;const done=once(p,"exit");p.stdin.end();p.kill();await done;}};
}
let client;
try {
  execFileSync("bun",["run","agent-bus","install","codex","--build-only","--dir",path.join(dir,"market"),"--url",bus.url],{stdio:"pipe"});
  copyFileSync(plugin+"/hooks/hooks.json",home+"/hooks.json");
  const conf=home+"/config.toml";
  writeFileSync(conf,`model_provider="mock"
model="mock"
[model_providers.mock]
name="mock"
base_url="http://127.0.0.1:${mock.address().port}/v1"
wire_api="responses"
[mcp_servers.message-bus]
command=${JSON.stringify(Bun.which("node"))}
args=[${JSON.stringify(plugin+"/dist/server.mjs")}]
env_vars=["CODEX_HOME"]
[mcp_servers.message-bus.env]
AGENT_BUS_JOIN_FROM_TMP="1"
AGENT_BUS_CODEX_CLI=${JSON.stringify(cli)}
AGENT_BUS_URL=${JSON.stringify(bus.url)}
`);
  client=await app();
  for (const h of (await client.rpc("hooks/list",{cwds:[project]})).data[0].hooks) {
    appendFileSync(conf,`\n[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash=${JSON.stringify(h.currentHash)}\n`);
  }
  const {thread}=await client.rpc("thread/start",{cwd:project,approvalPolicy:"never",sandbox:"read-only"});
  await client.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"initial fixture setup"}]});
  await wait(()=>client.completed.includes(thread.id));
  await wait(async()=> (await participant())?.online);
  await client.stop(); client=undefined;
  await wait(async()=>!(await participant())?.online);
  // Simulate a crash which left the writer file behind. Existence is not ownership.
  writeFileSync(path.join(home,"thread-writer-locks",thread.id+".lock"),"",{flag:"a"});
  const before=requests;
  client=await app();
  // Starting an unrelated chat in the very same folder must not restore the saved one.
  await client.rpc("thread/start",{cwd:project,approvalPolicy:"never",sandbox:"read-only"});
  await Bun.sleep(2000);
  assert.ok(!(await participant())?.online);
  await client.rpc("thread/resume",{threadId:thread.id,cwd:project});
  const agent=await wait(async()=>{const p=await participant();return p?.online && p;});
  await Bun.sleep(1200);
  assert.equal((await participant()).connections,1);
  assert.equal(requests,before);assert.deepEqual(client.started,[]);
  console.log("Reopened online; one connection, zero turns and zero model requests.");
  const posted=await fetch(bus.url+"/api/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({from:"tester",to:"@"+agent.id,text:"reopen smoke delivery"})});
  assert.equal(posted.status,200);const {message}=await posted.json();
  await wait(()=>client.completed.includes(thread.id)&&delivered);
  assert.deepEqual(client.started,[thread.id]);
  const {message:seen}=await(await fetch(bus.url+"/api/messages/"+message.seq)).json();
  assert.ok(seen.receipts[0]?.seenAt);console.log("One incoming bus message woke exactly the reopened chat and was seen.");
} finally {
  await client?.stop();mock.closeAllConnections();mock.close();await bus.stop();
  rmSync(dir,{recursive:true,force:true});
}
