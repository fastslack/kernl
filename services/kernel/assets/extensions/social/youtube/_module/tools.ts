import { z } from "zod";
import { type ToolDefinition, defineTool, defineToolNoInput, textResult, errorResult, limitArg } from "@kernl/extension-sdk";
import type { YouTubeService } from "./service.js";

export function youtubeTools(service: YouTubeService): ToolDefinition[] {
  return [
    // ── Account management ──────────────────────

    defineTool({
      name: "kernel_youtube_add_account",
      description:
        "Add a YouTube channel. Requires OAuth credentials: client_id, client_secret (Google Cloud project), and refresh_token. Run the OAuth dance manually once at https://developers.google.com/oauthplayground (scope: youtube.upload + youtube.readonly) to get the refresh_token.",
      schema: z.object({
        channel_id: z.string().describe("YouTube channel ID (UCxxx…). Use kernel_youtube_fetch_channel to backfill if unknown."),
        channel_title: z.string().optional(),
        client_id: z.string().describe("OAuth client_id from Google Cloud Console"),
        client_secret: z.string().describe("OAuth client_secret"),
        refresh_token: z.string().describe("OAuth refresh_token obtained from the consent flow"),
        role: z.enum(["brand", "founder", "community", "other"]).optional(),
      }),
      handler: async (input) => {
        const acc = service.addAccount(input);
        return textResult(
          `YouTube account added:\n  ID: ${acc.id}\n  Channel: ${acc.channel_title || acc.channel_id}\n  Role: ${acc.role}\n  Next: run kernel_youtube_fetch_channel to verify and pull subscribers/views.`,
        );
      },
    }),

    defineToolNoInput({
      name: "kernel_youtube_list_accounts",
      description: "List all configured YouTube accounts.",
      handler: async () => {
        const accounts = service.listAccounts();
        if (accounts.length === 0) return textResult("No YouTube accounts configured.");
        const lines = accounts.map(
          (a) =>
            `[${a.status.toUpperCase()}] ${a.channel_title || a.channel_id}\n  Role: ${a.role}\n  Subs: ${a.subscribers} · Views: ${a.total_views} · Videos: ${a.total_videos}\n  ID: ${a.id}`,
        );
        return textResult(`${accounts.length} account(s):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_youtube_delete_account",
      description: "Remove a YouTube account from Kernl.",
      schema: z.object({ account_id: z.string() }),
      handler: async ({ account_id }) => {
        return service.deleteAccount(account_id)
          ? textResult(`YouTube account ${account_id} deleted.`)
          : errorResult(`Account ${account_id} not found.`);
      },
    }),

    defineTool({
      name: "kernel_youtube_fetch_channel",
      description: "Refresh channel info (subscribers, total views, video count) for an account.",
      schema: z.object({ account_id: z.string() }),
      handler: async ({ account_id }) => {
        const info = await service.fetchChannel(account_id);
        return textResult(
          `Channel synced:\n  ID: ${info.id}\n  Title: ${info.title}\n  Subscribers: ${info.subscribers}\n  Views: ${info.views}\n  Videos: ${info.videos}`,
        );
      },
    }),

    // ── Uploading ──────────────────────────────────

    defineTool({
      name: "kernel_youtube_upload",
      description:
        "Upload a video file to YouTube. The file must exist locally — provide an absolute path. Uses resumable upload (single-shot). Privacy defaults to 'private' for safety; change to 'public' or 'unlisted' explicitly.",
      schema: z.object({
        account_id: z.string(),
        file_path: z.string().describe("Absolute path to the video file on disk"),
        title: z.string().describe("Video title (max 100 chars)"),
        description: z.string().optional().describe("Description (max 5000 chars). Markdown not supported — use newlines."),
        tags: z.array(z.string()).optional().describe("List of tag strings"),
        category_id: z.string().optional().describe("YouTube category ID — default '22' (People & Blogs). Other common: '28' Science & Tech, '27' Education."),
        privacy: z.enum(["public", "unlisted", "private"]).optional().describe("Default: 'private' — change explicitly for publication"),
      }),
      handler: async (input) => {
        const video = await service.upload(input);
        return textResult(
          `Video uploaded:\n  YouTube ID: ${video.video_id}\n  URL: https://youtu.be/${video.video_id}\n  Privacy: ${video.privacy}\n  Status: ${video.status}\n  Local entry: ${video.id}`,
        );
      },
    }),

    defineTool({
      name: "kernel_youtube_update_video",
      description:
        "Update title / description / tags / privacy of an already-uploaded video on YouTube.",
      schema: z.object({
        account_id: z.string(),
        video_id: z.string().describe("YouTube video ID (the 11-char one from the URL)"),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        category_id: z.string().optional(),
        privacy: z.enum(["public", "unlisted", "private"]).optional(),
      }),
      handler: async (input) => {
        await service.updateVideo(input);
        return textResult(`Video ${input.video_id} updated on YouTube.`);
      },
    }),

    defineTool({
      name: "kernel_youtube_list_videos",
      description: "List videos tracked in Kernl.",
      schema: z.object({
        account_id: z.string().optional(),
        status: z.enum(["draft", "uploading", "uploaded", "failed"]).optional(),
        limit: limitArg(100),
      }),
      handler: async (input) => {
        const videos = service.listVideos(input);
        if (videos.length === 0) return textResult("No videos found.");
        const lines = videos.map(
          (v) =>
            `[${v.status.toUpperCase()}] ${v.title}\n  YouTube: ${v.video_id ? `https://youtu.be/${v.video_id}` : "n/a"}\n  Privacy: ${v.privacy} · Views: ${v.views} · Likes: ${v.likes} · Comments: ${v.comments_count}\n  ID: ${v.id}${v.error ? `\n  Error: ${v.error}` : ""}`,
        );
        return textResult(`${videos.length} video(s):\n\n${lines.join("\n\n")}`);
      },
    }),

    defineTool({
      name: "kernel_youtube_sync_stats",
      description: "Refresh views/likes/comments count for a specific uploaded video.",
      schema: z.object({
        account_id: z.string(),
        video_id: z.string().describe("YouTube video ID"),
      }),
      handler: async (input) => {
        const stats = await service.syncVideoStats(input);
        return textResult(
          `Stats synced:\n  Views: ${stats.views}\n  Likes: ${stats.likes}\n  Comments: ${stats.comments}`,
        );
      },
    }),
  ];
}
