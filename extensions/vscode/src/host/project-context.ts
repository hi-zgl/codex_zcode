import { posix } from 'node:path';
import {createHash} from 'node:crypto';
import type {UiProject} from './types.js';

/** Paths are supplied only by the current VS Code workspace Host, never the Webview. */
export interface ProjectContext {
  workspaceFolderPaths: readonly string[];
  activeFilePath?: string | null;
}
export interface RegisteredProjectWorkspace {
  workspaceId: string;
  repositoryPath: string;
  worktreePath: string;
}
function absolute(value: string | null | undefined): string | null {
  if (!value || !posix.isAbsolute(value) || value.includes('\0')) return null;
  const normalized = posix.normalize(value);
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}
function contains(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(root === '/' ? '/' : `${root}/`); }

/** Read-only choices from existing facts. This neither registers a repository nor prepares a worktree. */
export function projectChoices(context:ProjectContext|undefined,workspaces:readonly RegisteredProjectWorkspace[],works:readonly {repositoryPath:string}[]):UiProject[] {
  const choices=new Map<string,UiProject>();
  const add=(value:string)=>{const repositoryPath=absolute(value);if(repositoryPath&&!choices.has(repositoryPath))choices.set(repositoryPath,{repositoryPath,repositoryId:`project-${createHash('sha256').update(repositoryPath).digest('hex').slice(0,24)}`});};
  for(const workspace of workspaces)add(workspace.repositoryPath);
  for(const work of works)add(work.repositoryPath);
  for(const folder of context?.workspaceFolderPaths??[]){
    const normalized=absolute(folder);
    // A folder inside a known source or execution tree stays with its source project.
    const knownRoots=[...workspaces.flatMap(workspace=>[workspace.repositoryPath,workspace.worktreePath]),...works.map(work=>work.repositoryPath)];
    if(normalized&&knownRoots.some(value=>{const root=absolute(value);return root&&contains(root,normalized);}))continue;
    add(folder);
  }
  return [...choices.values()];
}

/**
 * Selects a registered project by path boundaries without reading files or running Git.
 * The returned ID identifies one registered workspace; the Host resolves its repository.
 * Ambiguous multi-root windows stay at the whole-pool view unless an active file identifies
 * one project. Duplicate task worktrees for one repository are one project, not ambiguity.
 */
export function resolvePreferredRepositoryId(context: ProjectContext, workspaces: readonly RegisteredProjectWorkspace[]): string | null {
  const registered = workspaces.flatMap(workspace => {
    const repository = absolute(workspace.repositoryPath); const worktree = absolute(workspace.worktreePath);
    return repository && workspace.workspaceId ? [{ id: workspace.workspaceId, repository, roots: [...new Set([repository, worktree].filter((root): root is string => root !== null))] }] : [];
  });
  const representative = (repository: string): string => registered.filter(item => item.repository === repository).map(item => item.id).sort()[0]!;
  const active = absolute(context.activeFilePath);
  if (active) {
    const matches = registered.flatMap(item => item.roots.filter(root => contains(root, active)).map(root => ({ repository: item.repository, length: root.length })));
    const longest = Math.max(0, ...matches.map(match => match.length));
    const projects = new Set(matches.filter(match => match.length === longest).map(match => match.repository));
    if (projects.size === 1) return representative([...projects][0]!);
    if (projects.size > 1) return null;
  }
  if (context.workspaceFolderPaths.length !== 1) return null;
  const folder = absolute(context.workspaceFolderPaths[0]); if (!folder) return null;
  const projects = new Set(registered.filter(item => item.roots.some(root => contains(folder, root) || contains(root, folder))).map(item => item.repository));
  return projects.size === 1 ? representative([...projects][0]!) : null;
}
