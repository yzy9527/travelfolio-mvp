#!/usr/bin/env node
/** Source-only ZIP writer using Node built-ins; no Python or external runtime. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.argv[2]||path.join(root,'dist-source/travelfolio-source.zip'));
const excluded=new Set(['.git','.idea','node_modules','dist','dist-source','coverage','backups','artifacts','.playwright','.cache','__pycache__']);
const files=[];async function walk(dir){for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,entry.name);if(entry.isSymbolicLink()||excluded.has(entry.name))continue;if(entry.isDirectory()){await walk(p);continue;}if(!entry.isFile()||p===output||entry.name==='SHA256SUMS.txt'||entry.name==='.DS_Store'||(/\.(zip|log|dump|pem|key|p12|sqlite|db|pyc|gz)$/i.test(entry.name))||(entry.name.startsWith('.env')&&entry.name!=='.env.example'))continue;files.push({name:path.relative(root,p).replaceAll(path.sep,'/'),bytes:await fs.readFile(p)});}}
await walk(root);for(const name of ['README.md','package.json','package-lock.json','api/migrations/001_initial.sql','LICENSE','.env.example','docs/OPERATIONS.md','docs/SECURITY.md'])if(!files.some(f=>f.name===name))throw Error('Missing '+name);
const sha=b=>createHash('sha256').update(b).digest('hex');
files.push({name:'SHA256SUMS.txt',bytes:Buffer.from(files.map(f=>`${sha(f.bytes)}  ${f.name}\n`).join(''))});
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});const crc32=b=>{let crc=0xffffffff;for(const x of b)crc=table[(crc^x)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;};
let offset=0;const chunks=[],central=[];for(const file of files){const name=Buffer.from('travelfolio-mvp/'+file.name),data=deflateRawSync(file.bytes),crc=crc32(file.bytes),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);h.writeUInt16LE(0x0021,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(file.bytes.length,22);h.writeUInt16LE(name.length,26);chunks.push(h,name,data);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(0x0021,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(file.bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);central.push(c,name);offset+=h.length+name.length+data.length;}
const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);const zip=Buffer.concat([...chunks,directory,end]);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,zip,{mode:0o600});console.log(JSON.stringify({path:output,files:files.length,bytes:zip.length,sha256:sha(zip)},null,2));
