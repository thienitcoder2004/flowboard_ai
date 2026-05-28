import type { AgentStatus } from "./flowboardTypes";

type Props = {
  projectName?: string;
  status: AgentStatus | null;
};

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`status-dot ${ok ? "ok" : "bad"}`}>
      <i />
      {label}
    </span>
  );
}

export default function FlowboardTopBar({ projectName, status }: Props) {
  return (
    <header className="topbar">
      <div className="crumb">
        <b>Flowboard V1</b>
        <span>/</span>
        <span>{projectName || "—"}</span>
      </div>

      <div className="status-row">
        <StatusDot ok={Boolean(status?.agent?.connected)} label="agent" />
        <StatusDot ok={Boolean(status?.extension?.connected)} label="extension" />
        <StatusDot
          ok={Boolean(status?.googleFlow?.loggedIn)}
          label={
            status?.googleFlow?.loggedIn
              ? `Google Flow: ${status.googleFlow.label || status.googleFlow.email || status.googleFlow.name || status.googleFlow.source || "connected"}`
              : "Google Flow: not login"
          }
        />
        <StatusDot
          ok={Boolean(status?.backendPackage)}
          label={
            status?.backendPackage
              ? `${status.backendPackage.name}@${status.backendPackage.version}`
              : "backend@?"
          }
        />
        <StatusDot
          ok={Boolean(status?.extensionPackage)}
          label={
            status?.extensionPackage
              ? `${status.extensionPackage.name}@${status.extensionPackage.version}`
              : "extension@?"
          }
        />
      </div>
    </header>
  );
}
