import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const temp = process.env.OPENCODE_QA_TMP ?? (process.platform === 'win32' ? tmpdir() : '/tmp/opencode');
mkdirSync(temp,{recursive:true});
const root = mkdtempSync(join(temp,'context-observe-qa-'));
const dirs = Object.fromEntries(['home','config','data','state','cache','tmp','project'].map(n => [n,join(root,n)]));
for (const dir of Object.values(dirs)) mkdirSync(dir,{recursive:true,mode:0o700});
const binary = process.env.OPENCODE_QA_BINARY ?? (process.platform === 'win32'
  ? join(process.env.APPDATA ?? '', 'npm/node_modules/@opencode/cli/bin/opencode.exe') : 'opencode');
const password = randomUUID(), wires = [];
let host, exit, log = '';
const websocketMode=process.env.OPENCODE_QA_WEBSOCKET==='1';
const require=createRequire(resolve('package.json'));
const websocket=websocketMode ? new (require('ws').WebSocketServer)({noServer:true}) : null;
let wsCount=0;
const mock = http.createServer(async (req,res) => {
  const chunks=[]; for await(const c of req) chunks.push(c);
  const raw=Buffer.concat(chunks).toString(); const body=JSON.parse(raw); wires.push(raw);
  const message={role:'assistant',content:'SYNTHETIC_REPLY'},usage={prompt_tokens:100,completion_tokens:5,total_tokens:105};
  if (!body.stream) {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'qa',object:'chat.completion',model:body.model,choices:[{index:0,message,finish_reason:'stop'}],usage}));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const [delta,finish] of [[message,null],[{},'stop']]) res.write(`data: ${JSON.stringify({id:'qa',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:finish}],...(finish?{usage}:{})})}\n\n`);
  res.end('data: [DONE]\n\n');
});
if(websocket) mock.on('upgrade',(req,socket,head)=>websocket.handleUpgrade(req,socket,head,client=>websocket.emit('connection',client)));
websocket?.on('connection',socket=>socket.on('message',frame=>{
  const raw=frame.toString();wires.push(raw);const index=++wsCount,id=`msg_${index}`,text='SYNTHETIC_REPLY';
  const item={type:'message',id,status:'completed',role:'assistant',content:[{type:'output_text',text,annotations:[],logprobs:[]}]};
  for(const event of [
    {type:'response.created',response:{id:`resp_${index}`}},
    {type:'response.output_item.added',item:{type:'message',id}},
    {type:'response.output_text.delta',item_id:id,delta:text},
    {type:'response.output_text.done',item_id:id,text},
    {type:'response.output_item.done',item},
    {type:'response.completed',response:{id:`resp_${index}`,output:[item],usage:{input_tokens:100,output_tokens:5,total_tokens:105}}},
  ])socket.send(JSON.stringify(event));
}));
try {
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const pick=net.createServer();await new Promise(r=>pick.listen(0,'127.0.0.1',r));const port=pick.address().port;await new Promise(r=>pick.close(r));
  const plugin = resolve('.');
  execFileSync('git',['init','-q'],{cwd:dirs.project});
  writeFileSync(join(dirs.project,'AGENTS.md'),'# Synthetic project\nSYNTHETIC_PROJECT_RULE\n');
  const neighbor=join(root,'prefix-plugin');mkdirSync(neighbor);
  const prefixFile=join(root,'prefix.txt');writeFileSync(prefixFile,'PREFIX_ORIGINAL');
  writeFileSync(join(neighbor,'server.js'),`import {readFileSync} from 'node:fs'; export default {id:'qa.prefix',async setup(ctx){const r=await ctx.session.hook('context',event=>{event.system.push({type:'text',text:readFileSync(${JSON.stringify(prefixFile)},'utf8')});});return()=>r.dispose();}};`);
  let config={model:'mock/gpt-x',default_agent:'probe',permission:'allow',update:'disable',snapshots:false,plugins:[{package:neighbor},{package:plugin}],
    provider:{mock:{id:'mock',name:'Mock',env:[],npm:'@ai-sdk/openai-compatible',models:{'gpt-x':{id:'gpt-x',name:'gpt-x',tool_call:true,reasoning:false,attachment:false,temperature:false,release_date:'2025-01-01',limit:{context:100000,output:10000},cost:{input:0,output:0},options:{}}},options:{apiKey:'SYNTHETIC_API_SECRET',baseURL:`http://127.0.0.1:${mock.address().port}/v1`}}},agents:{probe:{mode:'primary',description:'QA fixture',system:'SYNTHETIC_ROLE'}}};
  if(websocketMode){
    const {provider: _legacy, ...rest}=config;
    config={...rest,providers:{mock:{name:'Mock websocket',package:'@opencode/ai/providers/openai',env:[],settings:{apiKey:'SYNTHETIC_API_SECRET',baseURL:`http://127.0.0.1:${mock.address().port}/v1`,transport:'websocket'},models:{'gpt-x':{modelID:'gpt-x',capabilities:{tools:true},limit:{context:100000,output:10000}}}}}};
  }
  writeFileSync(join(dirs.config,'opencode.json'),JSON.stringify(config),{mode:0o600});
  writeFileSync(join(dirs.project,'opencode.json'),JSON.stringify(config),{mode:0o600});
  const env={PATH:process.env.PATH,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,COMSPEC:process.env.COMSPEC,PATHEXT:process.env.PATHEXT,APPDATA:join(root,'appdata'),LOCALAPPDATA:join(root,'localappdata')}:{}),HOME:dirs.home,USERPROFILE:dirs.home,OPENCODE_TEST_HOME:dirs.home,XDG_CONFIG_HOME:dirs.config,XDG_DATA_HOME:dirs.data,XDG_STATE_HOME:dirs.state,XDG_CACHE_HOME:dirs.cache,TMPDIR:dirs.tmp,TEMP:dirs.tmp,TMP:dirs.tmp,OPENCODE_CONFIG_DIR:dirs.config,OPENCODE_DB:join(dirs.data,'qa.db'),OPENCODE_PASSWORD:password,OPENCODE_SERVER_PASSWORD:password,OPENCODE_DISABLE_EXTERNAL_SKILLS:'1',OPENCODE_DISABLE_CLAUDE_CODE_SKILLS:'1',OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_AUTH_CONTENT:'{}',NO_COLOR:'1'};
  const version=execFileSync(binary,['--version'],{env,encoding:'utf8'}).trim();
  host=spawn(binary,['serve','--hostname','127.0.0.1','--port',String(port)],{env,cwd:dirs.project,stdio:['ignore','pipe','pipe']});exit=once(host,'exit');host.stdout.on('data',c=>log+=c);host.stderr.on('data',c=>log+=c);
  const api=async(path,method='GET',body,authenticated=true)=>{
    const u=new URL(path,`http://127.0.0.1:${port}`);u.searchParams.set('location[directory]',dirs.project);
    const r=await fetch(u,{method,headers:{...(authenticated?{authorization:`Basic ${Buffer.from('opencode:'+password).toString('base64')}`} : {}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
    const text=await r.text(); if(!authenticated)return {status:r.status};assert(r.ok,`${path}:${r.status} ${text.slice(0,500)}`);return text?JSON.parse(text):null;
  };
  let ready=false,lastPlugins;
  for(let n=0;n<60;n++){try{const p=await api('/api/plugin');lastPlugins=p;if(p.data.some(p=>p.id==='o3p.context.observe'&&p.state?.status==='active')){ready=true;break;}if(p.data.some(p=>p.state?.status==='failed'))break;}catch{}await pause(1000);}
  assert(ready,`observer not active ${JSON.stringify(lastPlugins)} ${log.slice(-1000)}`);
  const rpc=async(method,input)=> (await api(`/api/rpc/o3p.context.observe/${method}`,'POST',{input})).output;
  const session=(await api('/api/session','POST',{location:{directory:dirs.project},agent:'probe',model:{providerID:'mock',id:'gpt-x'},title:'Synthetic observer QA'})).data;
  const send=async(text)=>{await api(`/api/session/${session.id}/prompt`,'POST',{text});await api(`/api/experimental/session/${session.id}/wait`,'POST');};
  await send('SYNTHETIC_FIRST'); await send('SYNTHETIC_SECOND');
  const list=await rpc('list',{});const rows=list.rows.filter(r=>r.kind==='primary');assert.equal(rows.length,2);
  const first=await rpc('detail',{id:rows[0].id}),second=await rpc('detail',{id:rows[1].id});
  assert.equal(first.raw,wires[0]);assert.equal(second.raw,wires[1]);assert.equal(first.row.mode,'snapshot');assert.equal(second.row.mode,'append');
  assert(second.delta.includes('SYNTHETIC_SECOND'));assert(!second.delta.includes('SYNTHETIC_FIRST'));assert(first.logical.includes('SYNTHETIC_ROLE'));assert(first.logical.includes('SYNTHETIC_PROJECT_RULE'));
  const lean=await rpc('detail',{id:rows[1].id,full:false});assert.equal(lean.raw,'');assert.equal(lean.logical,'');assert.equal(lean.previous,null);assert(lean.delta.includes('SYNTHETIC_SECOND'));
  assert(!JSON.stringify(first).includes('SYNTHETIC_API_SECRET'));assert.equal((await api('/api/rpc/o3p.context.observe/list','POST',{input:{}},false)).status,401);
  assert.equal(await rpc('detail',{id:'missing'}),null);assert.equal((await rpc('list',{after:rows[0].seq})).rows.length,1);
  if(websocketMode){assert(rows.every(row=>row.transport==='websocket'));assert.equal(JSON.parse(second.raw).previous_response_id,'resp_1');assert(!second.raw.includes('SYNTHETIC_FIRST'));}
  // Expose a synthetic live surface for parent browser/TUI QA when explicitly requested.
  console.log(JSON.stringify({version,pluginID:'o3p.context.observe',captured:rows.length,transport:websocketMode?'websocket':'http',nativeIncremental:websocketMode,exactWireBytes:true,appendOnly:true,leanQuery:true,rawSecretsAbsent:true,unauthorizedRejected:true,fixturesOnly:true}));
  if(process.env.OPENCODE_QA_HOLD==='1'){
    writeFileSync(join(root,'connection.json'),JSON.stringify({port,password,project:dirs.project,sessionID:session.id,prefixFile}),{mode:0o600});
    console.log(`QA_CONNECTION=${join(root,'connection.json')}`);
    await new Promise(r=>process.once('SIGTERM',r));
  }
} catch(error){console.error(error);console.error(log.replaceAll(password,'[redacted]').slice(-5000));process.exitCode=1;}
finally{
  if(host&&host.exitCode===null&&host.signalCode===null){host.kill('SIGTERM');const timer=setTimeout(()=>host.kill('SIGKILL'),5000);await exit;clearTimeout(timer);}
  if(websocket){for(const client of websocket.clients)client.terminate();websocket.close();}
  mock.closeAllConnections();await new Promise(r=>mock.close(r));rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});console.log('Owned QA host, mock and sandbox cleaned.');
}
