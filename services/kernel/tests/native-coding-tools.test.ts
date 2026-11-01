import { test, expect } from 'bun:test';
import { createNativeCodingTools } from '../assets/extensions/agents/agent-advanced/_module/native-coding-tools.js';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('native coding tools perform shell and filesystem work through the sandbox executable', async () => {
 const cwd = await mkdtemp(join(tmpdir(), 'native-tools-'));
 const wrapper = join(cwd, 'wrapper');
 await writeFile(wrapper, '#!/bin/sh\nexec "$@"\n'); await chmod(wrapper, 0o755);
 const session = createNativeCodingTools({ executablePath: wrapper, cwd, allowed: ['Bash','Read','Edit','Write','Glob','Grep'], denied: [], includeBash: true });
 const call = (name: string, input: unknown) => session.tools.find(t => t.name === name)!.handler(input);
 try {
  expect((await call('Write', {file_path:'hello.txt',content:'before'})).isError).toBeFalsy();
  expect((await call('Edit', {file_path:'hello.txt',old_string:'before',new_string:'after'})).isError).toBeFalsy();
  expect((await call('Read', {file_path:'hello.txt'})).content[0].text).toContain('after');
  expect((await call('Bash', {command:'cat hello.txt'})).content[0].text).toContain('after');
  expect((await call('Glob', {pattern:'*.txt'})).content[0].text).toContain('hello.txt');
  expect((await call('Grep', {pattern:'after'})).content[0].text).toContain('hello.txt');
 } finally { await session.cleanup(); await rm(cwd,{recursive:true,force:true}); }
});
test('denied tools and missing Bash permission cannot be called', async () => {
 const s = createNativeCodingTools({executablePath:'/missing',cwd:'/tmp',allowed:['Read','Bash'],denied:['Read'],includeBash:false});
 expect(s.tools.map(t=>t.name)).toEqual([]); await s.cleanup();
});
test('file tools reject workspace escapes and exact edits reject ambiguous text', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'native-bounds-'));
 const wrapper=join(cwd,'wrapper');await writeFile(wrapper,'#!/bin/sh\nexec "$@"\n');await chmod(wrapper,0o755);
 const s=createNativeCodingTools({executablePath:wrapper,cwd,allowed:['Read','Write','Edit'],denied:[],includeBash:false});
 const call=(name:string,args:unknown)=>s.tools.find(t=>t.name===name)!.handler(args);
 try {
  expect((await call('Read',{file_path:'/etc/passwd'})).isError).toBe(true);
  await call('Write',{file_path:'a',content:'same same'});
  expect((await call('Edit',{file_path:'a',old_string:'same',new_string:'new'})).isError).toBe(true);
  await s.cleanup();
  expect((await call('Read',{file_path:'a'})).isError).toBe(true);
 } finally {await s.cleanup();await rm(cwd,{recursive:true,force:true});}
});
test('explicit host workspace mount sources are nonempty and volume paths fail visibly', async () => {
 const { nativeFallbackBindSource }=await import('../assets/extensions/agents/agent-advanced/_module/native-coding-tools.js');
 const cwd='/home/fastslack/mtwProjects/Acme/agents-office';
 expect(nativeFallbackBindSource(cwd,'')).toBe(cwd);
 expect(nativeFallbackBindSource('/app/data/workspaces/test','/srv/kernel/data/workspaces/test')).toBe('/srv/kernel/data/workspaces/test');
 expect(()=>nativeFallbackBindSource('/app/data/workspaces/test','')).toThrow('host mapping');
});
