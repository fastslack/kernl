import { useState, useEffect } from "react";

interface KernelStatus {
  uptime: number;
  tasks: { pending: number; inProgress: number; done: number };
  reminders: { active: number; overdue: number };
  contacts: number;
  channels: Array<{ name: string; status: "online" | "offline" }>;
}

interface Channel {
  name: string;
  icon: string;
  status: "online" | "offline";
}

function App() {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const channels: Channel[] = [
    { name: "Telegram", icon: "telegram", status: "online" },
    { name: "WhatsApp", icon: "whatsapp", status: "offline" },
    { name: "Slack", icon: "slack", status: "offline" },
    { name: "Discord", icon: "discord", status: "offline" },
  ];

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  async function fetchStatus() {
    try {
      const baseUrl = import.meta.env.VITE_KERNEL_URL || "http://localhost:3086";
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        const data = await res.json();
        setConnected(true);
        setStatus(data);
      } else {
        setConnected(false);
      }
    } catch {
      setConnected(false);
    }
  }

  async function sendMessage() {
    if (!message.trim()) return;
    
    setLoading(true);
    try {
      const baseUrl = import.meta.env.VITE_KERNEL_URL || "http://localhost:3086";
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim() }),
      });
      
      if (res.ok) {
        setMessage("");
        // Show notification with response
        const data = await res.json();
        if (window.__TAURI__) {
          const { sendNotification } = await import("@tauri-apps/plugin-notification");
          await sendNotification({
            title: "Kernl",
            body: data.response?.slice(0, 100) || "Message sent",
          });
        }
      }
    } catch (err) {
      console.error("Failed to send message:", err);
    } finally {
      setLoading(false);
    }
  }

  async function openDashboard() {
    const baseUrl = import.meta.env.VITE_KERNEL_URL || "http://localhost:3086";
    if (window.__TAURI__) {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(baseUrl);
    } else {
      window.open(baseUrl, "_blank");
    }
  }

  async function openSettings() {
    // TODO: Open settings window
    console.log("Open settings");
  }

  return (
    <div className="app">
      <header className="header">
        <h1>
          <span className="logo">K</span>
          Kernl
        </h1>
        <div className={`status-badge ${connected ? "online" : "offline"}`}>
          <span className="status-dot" />
          {connected ? "Connected" : "Disconnected"}
        </div>
      </header>

      <section className="section">
        <div className="section-title">Quick Stats</div>
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-value">{status?.tasks?.pending ?? "-"}</div>
            <div className="stat-label">Tasks Pending</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{status?.reminders?.active ?? "-"}</div>
            <div className="stat-label">Active Reminders</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{status?.contacts ?? "-"}</div>
            <div className="stat-label">Contacts</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">
              {status?.reminders?.overdue ?? "-"}
            </div>
            <div className="stat-label">Overdue</div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-title">Channels</div>
        <div className="channel-list">
          {channels.map((ch) => (
            <div key={ch.name} className="channel-item">
              <span className="channel-name">
                <span className="channel-icon">{getChannelEmoji(ch.name)}</span>
                {ch.name}
              </span>
              <div className={`status-badge ${ch.status}`}>
                <span className="status-dot" />
                {ch.status}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-title">Quick Actions</div>
        <div className="quick-actions">
          <button className="action-btn" onClick={openDashboard}>
            <span>Dashboard</span>
          </button>
          <button className="action-btn" onClick={() => fetchStatus()}>
            <span>Refresh Status</span>
          </button>
          <button className="action-btn" onClick={openSettings}>
            <span>Settings</span>
          </button>
        </div>
      </section>

      <div className="chat-input-container">
        <input
          type="text"
          className="chat-input"
          placeholder="Send a message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
        />
        <button 
          className="send-btn" 
          onClick={sendMessage}
          disabled={loading || !message.trim()}
        >
          {loading ? "..." : "Send"}
        </button>
      </div>

      <footer className="footer">
        <span>v0.1.0</span>
        <a href="#" onClick={(e) => { e.preventDefault(); openDashboard(); }}>
          Open Dashboard
        </a>
      </footer>
    </div>
  );
}

function getChannelEmoji(name: string): string {
  switch (name.toLowerCase()) {
    case "telegram": return "paper_plane";
    case "whatsapp": return "phone";
    case "slack": return "#";
    case "discord": return "game_die";
    default: return "speech_balloon";
  }
}

export default App;

// Type declaration for Tauri
declare global {
  interface Window {
    __TAURI__?: object;
  }
}
