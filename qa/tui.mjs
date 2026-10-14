import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
const fixture=JSON.parse(readFileSync(process.argv[2],'utf8'));
const root=dirname(process.argv[2]);
const env={...process.env,HOME:join(root,'home'),USERPROFILE:join(root,'home'),XDG_CONFIG_HOME:join(root,'config'),
  XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),
  TMPDIR:join(root,'tmp'),TEMP:join(root,'tmp'),TMP:join(root,'tmp'),OPENCODE_TEST_HOME:join(root,'home'),
  OPENCODE_CONFIG_DIR:join(root,'config'),OPENCODE_DB:join(root,'data/qa.db'),OPENCODE_PASSWORD:fixture.password,
  OPENCODE_SERVER_PASSWORD:fixture.password,OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',COLORTERM:'truecolor',TERM:'xterm-256color'};
const binary=process.env.OPENCODE_QA_BINARY ?? (process.platform==='win32'
  ? join(process.env.APPDATA ?? '', 'npm/node_modules/@opencode/cli/bin/opencode.exe') : 'opencode');
const child=spawn(binary,
  [fixture.project,'--server',`http://127.0.0.1:${fixture.port}`,'--session',fixture.sessionID],{env,cwd:fixture.project,stdio:'inherit'});
child.on('exit',code=>process.exit(code??1));
process.on('SIGTERM',()=>child.kill('SIGTERM'));
