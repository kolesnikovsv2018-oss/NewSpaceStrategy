import { z } from 'zod';
import { factionIdSchema } from './campaign';
import { designSchema, validateDesign } from './shipDesign';

export const MAX_CAMPAIGN_PROJECTS = 25;
export const MAX_PROJECT_ID = 1_000_000_000;
const projectIdSchema = z.number().int().min(1).max(MAX_PROJECT_ID);
const nameSchema = z.string().trim().min(1).max(80);
export const projectSchema = z.object({
  id: projectIdSchema, factionId: factionIdSchema, name: nameSchema,
  design: designSchema.refine(design => validateDesign(design, 'draft').length === 0, 'Недопустимый черновик')
}).strict().refine(project => project.name === project.design.name, 'Имена записи и чертежа должны совпадать');
export type CampaignProject = z.infer<typeof projectSchema>;
export const projectCatalogSchema = z.object({
  lastProjectId: z.number().int().min(0).max(MAX_PROJECT_ID),
  items: z.array(projectSchema).max(MAX_CAMPAIGN_PROJECTS)
}).strict().superRefine((catalog, context) => {
  if (new Set(catalog.items.map(project => project.id)).size !== catalog.items.length ||
    catalog.items.some(project => project.id > catalog.lastProjectId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Проекты требуют уникальные ранее выданные ID' });
  }
});
export const campaignProjectsSchema = z.object({ blue: projectCatalogSchema, red: projectCatalogSchema }).strict()
  .superRefine((projects, context) => {
    for (const faction of factionIdSchema.options) if (projects[faction].items.some(project => project.factionId !== faction)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Проект требует своего владельца каталога' });
    }
  });
export type CampaignProjects = z.infer<typeof campaignProjectsSchema>;
export function createCampaignProjects(): CampaignProjects {
  return { blue: { lastProjectId: 0, items: [] }, red: { lastProjectId: 0, items: [] } };
}
const context = { factionId: factionIdSchema, expectedTurn: z.number().int().min(1).max(1_000_000_000) };
export const projectCommandSchema = z.discriminatedUnion('kind', [
  z.object({ ...context, kind: z.literal('createProject'), name: nameSchema, design: designSchema }).strict(),
  z.object({ ...context, kind: z.literal('copyProject'), projectId: projectIdSchema, name: nameSchema.optional() }).strict(),
  z.object({ ...context, kind: z.literal('renameProject'), projectId: projectIdSchema, name: nameSchema }).strict(),
  z.object({ ...context, kind: z.literal('replaceProject'), projectId: projectIdSchema, design: designSchema }).strict(),
  z.object({ ...context, kind: z.literal('deleteProject'), projectId: projectIdSchema }).strict()
]);
export type ProjectCommand = z.infer<typeof projectCommandSchema>;
export type ProjectErrorCode = 'PROJECT_LIMIT' | 'PROJECT_NOT_FOUND' | 'PROJECT_ID_LIMIT' | 'INVALID_DESIGN';
type ProjectResult = { ok: true; projects: CampaignProjects } | { ok: false; code: ProjectErrorCode; message: string };

/** The Conquest boundary authorizes the command and research policy before this detached edit. */
export function editCampaignProject(input: CampaignProjects, command: ProjectCommand): ProjectResult {
  const projects = campaignProjectsSchema.parse(input), catalog = projects[command.factionId];
  const project = command.kind === 'createProject' ? undefined : catalog.items.find(item => item.id === command.projectId);
  if (command.kind !== 'createProject' && !project) return { ok: false, code: 'PROJECT_NOT_FOUND', message: 'Проект стороны не найден' };
  if (command.kind === 'createProject' || command.kind === 'copyProject') {
    if (catalog.items.length === MAX_CAMPAIGN_PROJECTS) return { ok: false, code: 'PROJECT_LIMIT', message: 'Достигнут предел проектов стороны' };
    if (catalog.lastProjectId === MAX_PROJECT_ID) return { ok: false, code: 'PROJECT_ID_LIMIT', message: 'Достигнут предел идентификаторов проектов' };
    const design = command.kind === 'createProject' ? command.design : project!.design;
    if (validateDesign(design, 'draft').length) return { ok: false, code: 'INVALID_DESIGN', message: 'Недопустимый черновик' };
    const name = command.name ?? `${design.name.slice(0, 72)} (копия)`;
    catalog.items.push({ id: ++catalog.lastProjectId, factionId: command.factionId, name,
      design: { ...structuredClone(design), name } });
  } else if (command.kind === 'deleteProject') {
    catalog.items = catalog.items.filter(item => item.id !== command.projectId);
  } else if (command.kind === 'renameProject') {
    project!.name = command.name; project!.design.name = command.name;
  } else {
    if (validateDesign(command.design, 'draft').length) return { ok: false, code: 'INVALID_DESIGN', message: 'Недопустимый черновик' };
    project!.design = structuredClone(command.design); project!.name = command.design.name;
  }
  return { ok: true, projects: campaignProjectsSchema.parse(projects) };
}
