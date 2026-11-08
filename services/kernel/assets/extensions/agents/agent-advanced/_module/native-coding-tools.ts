import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '@kernl/extension-sdk';
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const names = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'] as const;
/** All filesystem operations execute inside the same sandbox boundary as Bash. */
const fileScript = `try {
    const fs = require('node:fs'), p = require('node:path');
    const a = JSON.parse(process.argv[1]), kind = process.argv[2], root = fs.realpathSync(process.cwd()), roots = [root, ...JSON.parse(process.argv[3] || '[]').filter(f => fs.existsSync(f)).map(f => fs.realpathSync(f))];
    function path(s, write = false) { const f = p.resolve(root, s || '.'); const target = fs.existsSync(f) ? fs.realpathSync(f) : fs.realpathSync(p.dirname(f)); if (!roots.some(r => target === r || target.startsWith(r + p.sep)))
        throw Error('Path outside workspace'); return f; }
    if (kind === 'Read') {
        console.log(fs.readFileSync(path(a.file_path), 'utf8').split('\\n').slice(Math.max(0, (a.offset || 1) - 1), a.limit ? Math.max(0, (a.offset || 1) - 1) + a.limit : undefined).join('\\n'));
    }
    if (kind === 'Write') {
        fs.writeFileSync(path(a.file_path, true), a.content);
        console.log('Written');
    }
    if (kind === 'Edit') {
        const f = path(a.file_path), s = fs.readFileSync(f, 'utf8');
        if (!a.old_string || !s.includes(a.old_string))
            throw Error('old_string not found');
        if (!a.replace_all && s.indexOf(a.old_string) !== s.lastIndexOf(a.old_string))
            throw Error('old_string is ambiguous');
        fs.writeFileSync(f, a.replace_all ? s.split(a.old_string).join(a.new_string) : s.replace(a.old_string, a.new_string));
        console.log('Edited');
    }
    if (kind === 'Glob' || kind === 'Grep') {
        const base = path(a.path || '.');
        let count = 0;
        const glob = kind === 'Glob' ? new Bun.Glob(a.pattern) : null;
        const re = kind === 'Grep' ? new RegExp(a.pattern) : null;
        function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (count >= 200)
                return;
            const f = p.join(dir, e.name);
            if (e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules')
                continue;
            if (e.isDirectory())
                walk(f);
            else if (e.isFile()) {
                const relative = p.relative(base, f);
                if (glob && glob.match(relative)) {
                    console.log(relative);
                    count++;
                }
                if (re) {
                    const lines = fs.readFileSync(f, 'utf8').split('\\n');
                    for (let i = 0; i < lines.length && count < 200; i++)
                        if (re.test(lines[i])) {
                            console.log(relative + ':' + (i + 1) + ':' + lines[i]);
                            count++;
                        }
                }
            }
        } }
        walk(base);
    }
}
catch (error) {
    console.error(String(error));
    process.exit(1);
}
`;
export function createNativeCodingTools(opts: {
    executablePath: string;
    cwd: string;
    allowed: string[];
    denied: string[];
    includeBash: boolean;
    fsRoots?: string[];
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
    cleanup?: () => Promise<void>;
}) {
    let closed = false;
    let tail: Promise<unknown> = Promise.resolve();
    const children = new Set<ReturnType<typeof spawn>>();
    const run = (command: string): Promise<ToolResult> => {
        const job = tail.then(async () => {
            if (closed)
                throw new Error('Native coding session is closed');
            return await new Promise<ToolResult>((resolve, reject) => {
                const child = spawn(opts.executablePath, ['sh', '-c', command], { cwd: opts.cwd, env: opts.env ?? { PATH: process.env.PATH, HOME: '/tmp' }, stdio: ['ignore', 'pipe', 'pipe'] });
                children.add(child);
                let output = '';
                const append = (chunk: Buffer) => { if (output.length < 100000)
                    output += chunk.toString().slice(0, 100000 - output.length); };
                child.stdout.on('data', append);
                child.stderr.on('data', append);
                const timer = setTimeout(() => { output += '\nCommand timed out'; child.kill('SIGKILL'); }, Math.min(opts.timeoutMs ?? 120000, 120000));
                child.on('error', reject);
                child.on('close', (code) => { clearTimeout(timer); children.delete(child); resolve({ content: [{ type: 'text', text: output || `Exit code ${code}` }], ...(code !== 0 ? { isError: true } : {}) }); });
            });
        });
        tail = job.catch(() => { });
        return job.catch(error => ({ isError: true, content: [{ type: 'text', text: String(error) }] }));
    };
    const schemas = {
        Bash: z.object({ command: z.string().min(1) }),
        Read: z.object({ file_path: z.string(), offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional() }),
        Write: z.object({ file_path: z.string(), content: z.string() }),
        Edit: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
        Glob: z.object({ pattern: z.string(), path: z.string().optional() }),
        Grep: z.object({ pattern: z.string(), path: z.string().optional() }),
    };
    const tools: ToolDefinition[] = names.filter(name => !opts.denied.includes(name) && (opts.allowed.length === 0 || opts.allowed.includes(name)) && (name !== 'Bash' || opts.includeBash)).map(name => ({
        name, description: `${name} in the run's coding workspace. Paths are relative to the workspace.`, inputSchema: schemas[name],
        handler: async (input) => { try {
            const args = schemas[name].parse(input);
            return await run(name === 'Bash' ? (args as {
                command: string;
            }).command : `bun -e ${quote(fileScript)} ${quote(JSON.stringify(args))} ${quote(name)} ${quote(JSON.stringify(opts.fsRoots ?? []))}`);
        }
        catch (error) {
            return { isError: true, content: [{ type: 'text', text: String(error) }] };
        } },
    }));
    return { tools, async cleanup() { if (closed)
            return; closed = true; for (const child of children)
            child.kill('SIGKILL'); await tail; await opts.cleanup?.(); } };
}

/** A kernel volume path is not a host bind source unless explicitly mapped. */
export function nativeFallbackBindSource(path: string, mapped: string): string {
    if (mapped) return mapped;
    if (path === "/app" || path.startsWith("/app/")) {
        throw new Error(`Native fallback requires a host mapping for additional mount ${path}`);
    }
    if (!path.startsWith("/")) throw new Error(`Native fallback mount must be absolute: ${path}`);
    return path;
}
