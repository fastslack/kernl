/**
 * MCP tools for Filesystem Commander — phase 1 surface.
 *
 * Naming follows `kernel_fs_*`. Handlers return Markdown text results that
 * are readable to both agents and humans in the MCP transcript.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { type ToolDefinition, defineTool, defineToolNoInput, textResult, errorResult } from "@kernl/extension-sdk";
import type { FsCommanderService } from "./service.js";
import type { FsEntry } from "./types.js";
import type { FsProvider } from "./providers/provider.js";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function icon(e: FsEntry): string {
  if (e.kind === "dir") return "📁";
  if (e.kind === "symlink") return "🔗";
  if (e.kind === "special") return "⚙︎";
  return "📄";
}

export function filesystemCommanderTools(
  service: FsCommanderService,
): ToolDefinition[] {
  return [
    defineTool({
      name: "kernel_fs_list",
      description:
        "List entries in a directory on the given filesystem provider. Use 'local' for the host filesystem, or the id returned by kernel_fs_remote_list for SFTP/S3/WebDAV.",
      schema: z.object({
        provider: z.string().default("local").describe("Provider id ('local' or remote id)"),
        path: z.string().describe("Absolute path within the provider's scope"),
      }),
      handler: async ({ provider, path }) => {
        const listing = await service.get(provider).list(path);
        const lines: string[] = [
          `**${path}** — ${listing.entries.length} entries`,
          ``,
          `| | Name | Size | Modified |`,
          `|-|------|------|----------|`,
        ];
        for (const e of listing.entries) {
          lines.push(
            `| ${icon(e)} | ${e.name}${e.kind === "dir" ? "/" : ""} | ${
              e.kind === "dir" ? "" : fmtBytes(e.size)
            } | ${e.mtime.slice(0, 19).replace("T", " ")} |`,
          );
        }
        return textResult(lines.join("\n"));
      },
    }),

    defineTool({
      name: "kernel_fs_stat",
      description: "Get metadata (size, mtime, permissions, kind) for a path.",
      schema: z.object({
        provider: z.string().default("local"),
        path: z.string(),
      }),
      handler: async ({ provider, path }) => {
        const s = await service.get(provider).stat(path);
        return textResult(
          [
            `**${s.path}**`,
            `- kind: ${s.kind}`,
            `- size: ${fmtBytes(s.size)} (${s.size} B)`,
            `- mtime: ${s.mtime}`,
            s.atime ? `- atime: ${s.atime}` : null,
            s.ctime ? `- ctime: ${s.ctime}` : null,
            s.permissions ? `- perms: ${s.permissions}` : null,
            s.target ? `- target: ${s.target}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    }),

    defineToolNoInput({
      name: "kernel_fs_providers",
      description: "List all filesystem providers currently registered.",
      handler: async () => {
        const list = service.listProviders();
        const lines = ["**Providers**", ""];
        for (const p of list) {
          lines.push(`- \`${p.id}\` — ${p.kind} (${p.label})`);
        }
        return textResult(lines.join("\n"));
      },
    }),

    defineToolNoInput({
      name: "kernel_fs_bookmarks_list",
      description: "List filesystem bookmarks.",
      handler: async () => {
        const rows = service.bookmarksList();
        if (!rows.length) return textResult("No bookmarks.");
        const lines = ["**Bookmarks**", ""];
        for (const b of rows) {
          lines.push(`- **${b.label}** → \`${b.provider_id}:${b.path}\``);
        }
        return textResult(lines.join("\n"));
      },
    }),

    defineTool({
      name: "kernel_fs_bookmarks_add",
      description: "Add a filesystem bookmark.",
      schema: z.object({
        label: z.string(),
        provider_id: z.string().default("local"),
        path: z.string(),
        sort_order: z.number().int().optional(),
      }),
      handler: async (input) => {
        const row = service.bookmarkAdd({
          label: input.label,
          providerId: input.provider_id,
          path: input.path,
          sortOrder: input.sort_order,
        });
        return textResult(`Bookmark added: \`${row.id}\` → **${row.label}**`);
      },
    }),

    defineTool({
      name: "kernel_fs_mkdir",
      description: "Create a directory on the given provider.",
      schema: z.object({
        provider: z.string().default("local"),
        path: z.string(),
        recursive: z.boolean().default(false),
      }),
      handler: async ({ provider, path, recursive }) => {
        await service.get(provider).mkdir(path, { recursive });
        return textResult(`Created: \`${path}\``);
      },
    }),

    defineTool({
      name: "kernel_fs_rename",
      description: "Rename or move a file/directory within the same provider.",
      schema: z.object({
        provider: z.string().default("local"),
        from: z.string(),
        to: z.string(),
      }),
      handler: async ({ provider, from, to }) => {
        await service.get(provider).rename(from, to);
        return textResult(`Renamed: \`${from}\` → \`${to}\``);
      },
    }),

    defineTool({
      name: "kernel_fs_delete",
      description:
        "Delete one or more paths. `recursive: true` is required to delete non-empty directories.",
      schema: z.object({
        provider: z.string().default("local"),
        paths: z.array(z.string()).min(1),
        recursive: z.boolean().default(false),
      }),
      handler: async ({ provider, paths, recursive }) => {
        const p = service.get(provider);
        const errors: string[] = [];
        let deleted = 0;
        for (const path of paths) {
          try {
            await p.rm(path, { recursive });
            deleted++;
          } catch (err) {
            errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return textResult(
          [
            `Deleted: ${deleted}/${paths.length}`,
            ...errors.map((e) => `  ⚠︎ ${e}`),
          ].join("\n"),
        );
      },
    }),

    defineTool({
      name: "kernel_fs_copy",
      description:
        "Copy files/directories between providers. Blocks until complete. For background + progress streaming use the /api/fs/ops/copy HTTP endpoint.",
      schema: z.object({
        src_provider: z.string().default("local"),
        dst_provider: z.string().default("local"),
        items: z.array(z.object({ from: z.string(), to: z.string() })).min(1),
        overwrite: z.boolean().default(false),
      }),
      handler: async ({ src_provider, dst_provider, items, overwrite }) => {
        const opId = service.ops.start({
          kind: "copy",
          src: service.get(src_provider),
          dst: service.get(dst_provider),
          items,
          overwrite,
        });
        const result = await waitForOp(service, opId);
        return result;
      },
    }),

    defineTool({
      name: "kernel_fs_move",
      description:
        "Move files/directories between providers (copy then delete source). Blocks until complete.",
      schema: z.object({
        src_provider: z.string().default("local"),
        dst_provider: z.string().default("local"),
        items: z.array(z.object({ from: z.string(), to: z.string() })).min(1),
        overwrite: z.boolean().default(false),
      }),
      handler: async ({ src_provider, dst_provider, items, overwrite }) => {
        const opId = service.ops.start({
          kind: "move",
          src: service.get(src_provider),
          dst: service.get(dst_provider),
          items,
          overwrite,
        });
        const result = await waitForOp(service, opId);
        return result;
      },
    }),

    defineTool({
      name: "kernel_fs_archive_open",
      description:
        "Open a zip archive as a virtual filesystem. Returns a provider id that can be used with kernel_fs_list/stat/read.",
      schema: z.object({
        source_provider: z.string().default("local"),
        path: z.string(),
      }),
      handler: async ({ source_provider, path }) => {
        const info = await service.openArchive(source_provider, path);
        return textResult(
          `Archive opened: \`${info.id}\` (${info.label})\n\nUse kernel_fs_list with provider=\`${info.id}\` to browse.`,
        );
      },
    }),

    defineTool({
      name: "kernel_fs_archive_close",
      description: "Close a previously opened archive provider.",
      schema: z.object({ provider: z.string() }),
      handler: async ({ provider }) => {
        await service.closeArchive(provider);
        return textResult(`Archive closed: ${provider}`);
      },
    }),

    defineToolNoInput({
      name: "kernel_fs_remote_list",
      description: "List configured remote filesystems (SFTP, S3, WebDAV). Credentials are never returned.",
      handler: async () => {
        const items = service.remotesList();
        if (!items.length) return textResult("No remotes configured.");
        const lines = ["**Remotes**", "", "| Kind | Label | Provider ID | Added |", "|------|-------|-------------|-------|"];
        for (const r of items) {
          lines.push(`| ${r.kind} | ${r.label} | \`${r.provider_id}\` | ${r.created_at.slice(0, 19).replace("T", " ")} |`);
        }
        return textResult(lines.join("\n"));
      },
    }),

    defineTool({
      name: "kernel_fs_remote_add",
      description:
        "Register a remote filesystem. Credentials are encrypted at rest via FS_COMMANDER_KEY. `config` shape depends on kind: " +
        "sftp → {host, port?, username, password? | privateKey?, passphrase?}; " +
        "s3 → {region?, accessKeyId, secretAccessKey, endpoint?, bucket, forcePathStyle?}; " +
        "webdav → {baseUrl, username?, password?, token?}.",
      schema: z.object({
        kind: z.enum(["sftp", "s3", "webdav"]),
        label: z.string().min(1),
        config: z.record(z.string(), z.unknown()),
      }),
      handler: async ({ kind, label, config }) => {
        const info = await service.addRemote({
          kind,
          label,
          config: config as unknown as Parameters<typeof service.addRemote>[0]["config"],
        });
        return textResult(
          `Remote added: **${info.label}** (${info.kind})\n\nProvider id: \`${info.provider_id}\``,
        );
      },
    }),

    defineTool({
      name: "kernel_fs_remote_remove",
      description: "Remove a remote by its internal id (not the provider_id).",
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        await service.removeRemote(id);
        return textResult(`Remote removed: ${id}`);
      },
    }),

    defineTool({
      name: "kernel_fs_remote_test",
      description: "Test connectivity to a remote by listing its root.",
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const r = await service.testRemote(id);
        return r.ok ? textResult("✓ Remote OK") : errorResult(r.error ?? "Connection failed");
      },
    }),

    defineTool({
      name: "kernel_fs_dedup",
      description:
        "Scan a subtree and report groups of duplicate files (same sha256). Reads each file once — may be slow on large trees.",
      schema: z.object({
        provider: z.string().default("local"),
        path: z.string(),
        max_files: z.number().int().min(1).max(100000).default(5000),
      }),
      handler: async ({ provider, path, max_files }) => {
        const p = service.get(provider);
        const hashes = new Map<string, Array<{ path: string; size: number }>>();
        let scanned = 0;
        let hashed = 0;
        await walkAndHash(p, path, async (full, stat) => {
          if (scanned >= max_files) return "stop";
          scanned++;
          if (stat.size === 0) return "ok";
          const h = await hashStream(p, full);
          hashed++;
          const list = hashes.get(h) ?? [];
          list.push({ path: full, size: stat.size });
          hashes.set(h, list);
          return "ok";
        });
        const dups = [...hashes.entries()].filter(([, v]) => v.length > 1);
        if (dups.length === 0) {
          return textResult(`No duplicates in ${path} (${hashed} files hashed).`);
        }
        const lines = [`**${dups.length} duplicate group(s)** in \`${path}\``, ""];
        let wastedBytes = 0;
        for (const [h, items] of dups) {
          wastedBytes += items[0].size * (items.length - 1);
          lines.push(`- \`${h.slice(0, 12)}…\` — ${items.length} copies × ${items[0].size} B`);
          for (const it of items) lines.push(`    - ${it.path}`);
        }
        lines.push("");
        lines.push(`Potential reclaim: **${wastedBytes} bytes**`);
        return textResult(lines.join("\n"));
      },
    }),
  ];
}

async function walkAndHash(
  provider: FsProvider,
  root: string,
  visit: (
    full: string,
    stat: { size: number },
  ) => Promise<"ok" | "stop">,
): Promise<void> {
  const queue: string[] = [root];
  while (queue.length) {
    const p = queue.shift()!;
    let listing;
    try {
      listing = await provider.list(p);
    } catch {
      continue;
    }
    for (const e of listing.entries) {
      // The local provider on Windows lists backslash paths; remote providers
      // always speak "/". Mixing them showed duplicates as C:\dir/file.
      const sep = provider.kind === "local" && process.platform === "win32" ? "\\" : "/";
      const full = p.endsWith("/") || p.endsWith(sep) ? p + e.name : p + sep + e.name;
      if (e.kind === "dir") {
        queue.push(full);
      } else if (e.kind === "file") {
        const stop = await visit(full, { size: e.size });
        if (stop === "stop") return;
      }
    }
  }
}

async function hashStream(provider: FsProvider, path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = await provider.readStream(path);
  for await (const chunk of stream as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest("hex");
}

async function waitForOp(
  service: FsCommanderService,
  opId: string,
): Promise<ReturnType<typeof textResult>> {
  return new Promise((resolve) => {
    const unsub = service.ops.subscribe(opId, (p) => {
      if (p.status === "done") {
        unsub();
        resolve(
          textResult(
            `Done — ${p.itemsDone}/${p.itemsTotal} items, ${fmtBytes(p.bytes)} transferred.`,
          ),
        );
      } else if (p.status === "error") {
        unsub();
        resolve(errorResult(`Op failed: ${p.errors.join("; ")}`));
      } else if (p.status === "cancelled") {
        unsub();
        resolve(errorResult("Op cancelled"));
      }
    });
  });
}
