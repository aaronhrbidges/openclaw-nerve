import guides from './deployment-guides.json';

export function shouldPrintDeploymentGuides(params: {
  invokedFromInstaller: boolean;
  defaultsMode: boolean;
}): boolean {
  return !(params.invokedFromInstaller && params.defaultsMode);
}

export function printDeploymentGuides(log: (line: string) => void = console.log): void {
  log('  Deployment guides:');
  for (const guide of guides) {
    log(`    ${guide.title}: \x1b[36m${guide.url}\x1b[0m`);
  }
  log('');
}
