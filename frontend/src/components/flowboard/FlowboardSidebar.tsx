import type { ProjectSummary } from "./flowboardTypes";

type Props = {
  projects: ProjectSummary[];
  activeProjectId?: string;
  onCreateProject: () => void | Promise<void>;
  onSelectProject: (projectId: string) => void | Promise<void>;
  onDeleteProject: (projectId: string) => void | Promise<void>;
};

export default function FlowboardSidebar({
  projects,
  activeProjectId,
  onCreateProject,
  onSelectProject,
  onDeleteProject,
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
        <div
          key={project.id}
          className={`project ${project.id === activeProjectId ? "active" : ""}`}
        >
          <button className="project-select" onClick={() => void onSelectProject(project.id)}>
            <span>{project.name}</span>
            <small>{project.nodeCount} nodes</small>
          </button>
          <button
            className="project-delete"
            aria-label={`Delete project ${project.name}`}
            onClick={() => void onDeleteProject(project.id)}
          >
            ×
          </button>
        </div>
      ))}
    </aside>
  );
}
