import type { ProjectSummary } from "./flowboardTypes";

type Props = {
  projects: ProjectSummary[];
  activeProjectId?: string;
  onCreateProject: () => void | Promise<void>;
  onSelectProject: (projectId: string) => void | Promise<void>;
};

export default function FlowboardSidebar({
  projects,
  activeProjectId,
  onCreateProject,
  onSelectProject,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="side-head">
        <b>PROJECTS</b>
        <button aria-label="Collapse projects">‹</button>
      </div>

      <button className="new-btn" onClick={onCreateProject}>
        + New project
      </button>

      {projects.map((project) => (
        <button
          key={project.id}
          className={`project ${project.id === activeProjectId ? "active" : ""}`}
          onClick={() => void onSelectProject(project.id)}
        >
          <span>{project.name}</span>
          <small>{project.nodeCount} nodes</small>
        </button>
      ))}
    </aside>
  );
}
