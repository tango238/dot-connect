import { Hono } from 'hono'
import { createLiveChanges } from './liveChanges'
import { apiTokenAuth } from './apiTokenAuth'
import { createCapabilitiesRoutes } from './capabilitiesRoutes'
import { csrfProtection } from './csrf'
import type { AppDependencies } from './dependencies'
import { createHerdrRoutes } from './herdrRoutes'
import { createLabelsRoutes } from './labelsRoutes'
import { createMilestonesRoutes } from './milestonesRoutes'
import { createModelsRoutes } from './modelsRoutes'
import { createPromptsRoutes } from './promptsRoutes'
import { createPullRequestsRoutes } from './pullRequestsRoutes'
import { createReportsRoutes } from './reportsRoutes'
import { createSettingsRoutes } from './settingsRoutes'
import { createTodoAttachmentRoutes } from './todoAttachmentRoutes'
import { createTodoCommentRoutes } from './todoCommentRoutes'
import { createTodoPullRequestRoutes } from './todoPullRequestRoutes'
import { createTodoSessionRoutes } from './todoSessionRoutes'
import { createTodosRoutes } from './todosRoutes'
import { createWorkspacesRoutes } from './workspacesRoutes'

export type { AppDependencies } from './dependencies'

export function createApiRoutes(deps: AppDependencies): Hono {
  const app = new Hono()

  app.use('*', apiTokenAuth(deps.apiToken, deps.isLoopback))
  app.use('*', csrfProtection(deps.port))

  const live = createLiveChanges(deps)
  app.use('*', live.mutations)
  // Browser-only: deliberately absent from the API-token allowlist.
  app.get('/events', live.events)

  app.route('/todos', createTodosRoutes(deps))
  app.route('/todos', createTodoSessionRoutes(deps))
  app.route('/todos', createTodoPullRequestRoutes(deps))
  app.route('/todos', createTodoAttachmentRoutes(deps))
  app.route('/todos', createTodoCommentRoutes(deps))
  app.route('/pull-requests', createPullRequestsRoutes(deps))
  app.route('/milestones', createMilestonesRoutes(deps))
  app.route('/labels', createLabelsRoutes(deps))
  app.route('/reports', createReportsRoutes(deps))
  app.route('/herdr', createHerdrRoutes(deps))
  app.route('/prompts', createPromptsRoutes(deps))
  app.route('/workspaces', createWorkspacesRoutes(deps))
  app.route('/models', createModelsRoutes(deps))
  app.route('/capabilities', createCapabilitiesRoutes(deps))
  // Browser-UI only — deliberately NOT added to apiTokenAuth.ts's allowlist.
  app.route('/settings', createSettingsRoutes(deps))

  return app
}
