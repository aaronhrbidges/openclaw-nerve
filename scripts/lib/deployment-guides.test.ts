import { describe, expect, it } from 'vitest';
import guides from './deployment-guides.json';

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
});
