import {mkdir,lstat,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** Private worker-only directory, never mounted in the web server. */
export class JobWorkspace {
  private constructor(readonly directory:string){}
  static async open(root:string,userId:string,jobId:string){
    if(!uuid.test(userId)||!uuid.test(jobId)||!path.isAbsolute(root))throw Error('INVALID_WORKSPACE');
    const base=path.resolve(root);await mkdir(base,{recursive:true,mode:0o700});
    // Do not follow pre-existing symlink roots or tenant/job components.
    for(const target of [base,path.join(base,userId),path.join(base,userId,jobId)]){
      try{await mkdir(target,{mode:0o700});}catch(e:any){if(e.code!=='EEXIST')throw e;}
      const info=await lstat(target);if(!info.isDirectory()||info.isSymbolicLink())throw Error('INVALID_WORKSPACE');
    }
    return new JobWorkspace(path.join(base,userId,jobId));
  }
  async write(name:string,value:string|Buffer){
    if(!/^[a-z0-9][a-z0-9.-]{0,100}$/.test(name))throw Error('INVALID_ARTIFACT_NAME');
    const temporary=path.join(this.directory,`${name}.${randomUUID()}.tmp`);
    await writeFile(temporary,value,{mode:0o600,flag:'wx'});
    await rename(temporary,path.join(this.directory,name));
  }
}
