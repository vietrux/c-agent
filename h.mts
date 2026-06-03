import { type Terminal } from "@earendil-works/pi-tui";
import { App } from "./src/tui/app.js";
import { Agent } from "./src/agent.js";
import { Session } from "./src/session.js";
import { buildRegistry } from "./src/tools/index.js";
import { ProcessManager } from "./src/process/manager.js";
import { PermissionEngine } from "./src/permissions.js";
import { FileCheckpointer } from "./src/checkpoint.js";
import { Vault } from "./src/utils/redact.js";
import type { Provider, NeutralMessage, ToolSpec, StreamHandlers, StreamResult } from "./src/provider/types.js";
class FT implements Terminal { onInput:(d:string)=>void=()=>{}; start(o:(d:string)=>void){this.onInput=o;} stop(){} write(){} get columns(){return 100;} get rows(){return 30;} moveBy(){} hideCursor(){} showCursor(){} clearLine(){} clearFromCursor(){} clearScreen(){} }
class SP implements Provider { model="stub"; private c=0; async stream(_s:string,_m:NeutralMessage[],_t:ToolSpec[],h:StreamHandlers):Promise<StreamResult>{ this.c++; const usage={input:1,output:1,cached:0}; if(this.c===1){h.onReasoning?.("thinking about it");return{text:"",toolCalls:[{id:"t1",name:"bash",input:{command:"echo hi"}}],usage};} h.onText("Done **hi**."); return{text:"Done **hi**.",toolCalls:[],usage};}}
const pm=new ProcessManager(),session=new Session(process.cwd()),registry=buildRegistry();
const engine=new PermissionEngine({},"bypass"); const cp=new FileCheckpointer();
const agent=new Agent(session,registry,{pm,cwd:process.cwd(),todos:[],engine,checkpointer:cp},new SP());
const uc={enabled:false,vault:new Vault(session.id)};
const term=new FT(); const app:any=new App(agent,session,engine,cp,uc,pm,[],null,term);
const tick=()=>new Promise(r=>setTimeout(r,30));
try{
 app.start(); await tick();
 for(const ch of "hi") term.onInput(ch); term.onInput("\r");
 await tick();await tick();await tick();
 // count consecutive spacers (double-blank detection)
 const blocks=app.view.blocks; let dbl=0;
 for(let i=1;i<blocks.length;i++){ if(blocks[i]?.constructor?.name==="Spacer" && blocks[i-1]?.constructor?.name==="Spacer") dbl++; }
 console.log("blocks:", blocks.map((b:any)=>b.constructor.name).join(","));
 console.log("double-spacers:", dbl, dbl===0?"PASS":"FAIL");
}catch(e:any){console.log("THROW",e?.message);}
pm.killAll();process.exit(0);
