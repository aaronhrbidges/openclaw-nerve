import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import guides from './deployment-guides.json';

const setupScriptSource = readFileSync(resolve(process.cwd(), 'scripts/setup.ts'), 'utf8');

describe('deployment guide metadata', () => {
  it('contains the expected public docs links and human-readable titles', () => {
    expect(guides).toEqual([
      {
        title: 'Run everything on one machine',
        url: 'https://docs.nerve.zone/guide/deployment-local',
      },
      {
        title: 'Use a cloud Gateway with Nerve on your laptop',
        url: 'https://docs.nerve.zone/guide/deployment-remote-gateway',
      },
      {
        title: 'Run both Nerve and Gateway in the cloud',
        url: 'https://docs.nerve.zone/guide/deployment-cloud',
      },
    ]);
  });

  it('wires deployment guides into setup completion output for both setup flows', () => {
    expect(setupScriptSource).toContain("import deploymentGuides from './lib/deployment-guides.json';");
    expect(setupScriptSource).toContain('function printDeploymentGuides(): void {');
    expect(setupScriptSource.match(/printDeploymentGuides\(\);/g)).toHaveLength(2);
  });
});
