import { readFileSync, writeFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync('src/domain/fixtures/rules-default.json', 'utf8'));
const initialDiplomacyState = {
  round: 0,
  war: false,
  trust: 0,
  reputation: { blue: 100, red: 100 },
  influence: { blue: 0, red: 0 },
  contact: { blue: null, red: null },
  veto: { capture: { blue: null, red: null }, breach: { blue: null, red: null } },
  nextProposalId: 1,
  nextTreatyId: 1,
  nextJournalId: 1,
  proposals: [],
  treaties: [],
  journal: [],
};

for (const turn of [199, 200]) {
  const path = `reports/2026-11-06/n15-ai-development/replays/40-41-current-ai-direct.before-${turn}.save.json`;
  const save = JSON.parse(readFileSync(path, 'utf8'));
  save.schemaVersion = 18;
  save.rulesVersion = 15;
  if (save.conquest.rules) save.conquest.rules.diplomacy = fixture.diplomacy;
  save.conquest.diplomacy = initialDiplomacyState;
  writeFileSync(path, JSON.stringify(save));
  console.log(`updated ${path} -> schema ${save.schemaVersion}, rules ${save.rulesVersion}`);
}
