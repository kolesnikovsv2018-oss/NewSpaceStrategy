import { parseDocument } from 'yaml';
import { researchTreeSchema, type ResearchTree } from '../domain/campaignResearch';

export const MAX_RESEARCH_TREE_BYTES = 256000;
export function parseResearchTreeYaml(input: string): ResearchTree {
  if (new TextEncoder().encode(input).length > MAX_RESEARCH_TREE_BYTES) throw new Error('Дерево исследований превышает 256 КБ');
  const document = parseDocument(input, { uniqueKeys: true, customTags: [] });
  if (document.errors.length || document.warnings.length) throw new Error('Недопустимый YAML');
  return researchTreeSchema.parse(document.toJS({ maxAliasCount: 0 }));
}