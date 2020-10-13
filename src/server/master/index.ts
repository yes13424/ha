import path from 'path';
import { writeFileSync, copyFile, readdir, mkdir, readdirSync } from 'fs';
import { promisify } from 'util';
import master from './master';
import creeveyServer from './server';
import creeveyApi from './api';
import { Config, Options, isDefined } from '../../types';
import { shutdownWorkers, testsToImages } from '../utils';
import { subscribeOn } from '../messages';

const copyFileAsync = promisify(copyFile);
const readdirAsync = promisify(readdir);
const mkdirAsync = promisify(mkdir);

async function copyStatics(reportDir: string): Promise<void> {
  const clientDir = path.join(__dirname, '../../client/web');
  const files = (await readdirAsync(clientDir, { withFileTypes: true }))
    .filter((dirent) => dirent.isFile() && !dirent.name.endsWith('.d.ts') && !dirent.name.endsWith('.tsx'))
    .map((dirent) => dirent.name);
  await mkdirAsync(reportDir, { recursive: true });
  for (const file of files) {
    await copyFileAsync(path.join(clientDir, file), path.join(reportDir, file));
  }
}

function reportDataModule<T>(data: T): string {
  return `
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.__CREEVEY_DATA__ = factory();
  }
}(this, function () { return ${JSON.stringify(data)} }));
`;
}

function readDirRecursive(dirPath: string): string[] {
  return ([] as string[]).concat(
    ...readdirSync(dirPath, { withFileTypes: true }).map((dirent) =>
      dirent.isDirectory() ? readDirRecursive(`${dirPath}/${dirent.name}`) : [`${dirPath}/${dirent.name}`],
    ),
  );
}

function outputUnnecessaryImages(imagesDir: string, images: Set<string>): void {
  console.log('We found unnecessary screenshot images, that can be freely removed:');
  readDirRecursive(imagesDir)
    .map((imagePath) => path.relative(imagesDir, imagePath))
    .filter((imagePath) => !images.has(imagePath))
    .forEach((imagePath) => console.log(imagePath));
}

export default async function (config: Config, options: Options): Promise<void> {
  if (config.hooks.after) {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    process.on('beforeExit', async () => {
      await config.hooks.after?.();
      // eslint-disable-next-line no-process-exit
      process.exit();
    });
  }
  if (config.hooks.before) {
    await config.hooks.before();
  }
  const runner = await master(config, options.ui);

  if (options.saveReport) {
    const reportDataPath = path.join(config.reportDir, 'data.js');
    await copyStatics(config.reportDir);
    subscribeOn('shutdown', () => writeFileSync(reportDataPath, reportDataModule(runner.status.tests)));
  }

  if (options.ui) {
    creeveyServer(creeveyApi(runner), config.reportDir, options.port);
  } else {
    // TODO Exit if runner don't have tests to run
    runner.once('stop', () => {
      const tests = Object.values(runner.status.tests);
      const isSuccess = tests
        .filter(isDefined)
        .filter(({ skip }) => !skip)
        .every(({ status }) => status == 'success');
      // TODO output summary
      process.exitCode = isSuccess ? 0 : -1;
      outputUnnecessaryImages(config.screenDir, testsToImages(tests));
      shutdownWorkers();
    });
    // TODO grep
    runner.start(Object.keys(runner.status.tests));
  }
}
