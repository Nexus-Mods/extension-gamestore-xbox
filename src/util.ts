/* eslint-disable */
/*
  Special thanks to the LOOT team for the original C++ implementation used to decipher the .gamingroot file.
*/
import * as path from 'path';
import walk from 'turbowalk';
import { fs, log, types, util } from 'vortex-api';
import { parseStringPromise } from 'xml2js';

import { APP_MANIFEST } from './common';
import { GamePathMap } from './types';

export async function findInstalledGames(api: types.IExtensionApi): Promise<GamePathMap> {
  const gamingRootPaths = await findXboxGamingRootPaths(api);
  const gamePathMap: GamePathMap = {};

  for (const gamingRootPath of gamingRootPaths) {
    const manifests = await findManifests(gamingRootPath, true);
    for (const manifest of manifests) {
      const gamePath = path.dirname(manifest);
      const data = await getAppManifestData(gamePath);
      const appId: string = data?.Package?.Identity?.[0]?.$?.Name;
      if (appId) {
        gamePathMap[appId] = gamePath;
      }
    }
  }
  return gamePathMap;
}

export async function findXboxGamingRootPaths(api: types.IExtensionApi): Promise<string[]> {
  let drives = api.store.getState().settings.gameMode.searchPaths;
  if (drives.length === 0) {
    drives = await util.getDriveList(api);
  }
  const gamingRootPaths = [];
  for (const drive of drives) {
    const gamingRootPath = await findXboxGamingRootPath(drive);
    if (gamingRootPath !== null) {
      gamingRootPaths.push(gamingRootPath);
    }
  }
  return gamingRootPaths;
}

export async function findXboxGamingRootPath(driveRootPath) {
  const gamingRootFilePath = `${driveRootPath}.GamingRoot`;

  try {
    const fileStats = await fs.statAsync(gamingRootFilePath);

    if (!fileStats.isFile()) {
      return null;
    }

    const fileContent: number[] = await fs.readFileAsync(gamingRootFilePath);

    // Log the content in hexadecimal format for debugging
    const hexBytes = Array.from(fileContent, byte => `0x${byte.toString(16)}`);
    log('debug', `Read the following bytes from ${gamingRootFilePath}: ${hexBytes.join(' ')}`);

    // The content of .GamingRoot is the byte sequence 52 47 42 58 01 00 00 00
    // followed by the null-terminated UTF-16LE location of the Xbox games folder
    // on the same drive.

    if (fileContent.length % 2 !== 0) {
      log('error', `Found a non-even number of bytes in the file at ${gamingRootFilePath}, cannot interpret it as UTF-16LE`);
      throw new Error(`Found a non-even number of bytes in the file at "${gamingRootFilePath}"`);
    }

    const content = [];
    for (let i = 0; i < fileContent.length; i += 2) {
      const highByte = fileContent[i];
      const lowByte = fileContent[i + 1];
      const value = highByte | (lowByte << 8); // Combine bytes for little-endian
      content.push(value);
    }

    const CHAR16_PATH_OFFSET = 4;
    if (content.length < CHAR16_PATH_OFFSET + 1) {
      log('error', `.GamingRoot content was unexpectedly short at ${content.length} char16_t long`);
      throw new Error(`The file at "${gamingRootFilePath}" is shorter than expected.`);
    }

    // Cut off the null char16_t at the end.
    const relativePath = String.fromCharCode.apply(null, content.slice(CHAR16_PATH_OFFSET, -1));

    log('debug', `Read the following relative path from .GamingRoot: ${relativePath}`);

    return `${driveRootPath}${relativePath}`;
  } catch (err) {
    log('debug', 'Not a valid xbox gaming path', err);
    // Don't propagate this error as it could be due to a legitimate failure
    // case like the drive not being ready (e.g. a removable disk drive with
    // nothing in it).
    return null;
  }
}

export async function findManifests(rootPath: string, recurse: boolean): Promise<string[]> {
  let fileList: string[] = [];
  return walk(rootPath, entries => {
    fileList = fileList.concat(
      entries
        .filter(iter => path.basename(iter.filePath) === APP_MANIFEST)
        .map(iter => iter.filePath));
  }, { recurse, skipHidden: true, skipLinks: true, skipInaccessible: true })
  .then(() => fileList);
}

export async function getAppManifestData(filePath: string) {
  const appManifestFilePath = path.join(filePath, APP_MANIFEST);
  return fs.readFileAsync(appManifestFilePath, { encoding: 'utf8' })
    .then((data) => parseStringPromise(data))
    .then((parsed) => Promise.resolve(parsed))
    .catch(err => Promise.resolve(undefined));
}
