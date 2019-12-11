// tslint:disable: max-line-length
import * as Promise from 'bluebird';
import * as path from 'path';
import { log, types, util } from 'vortex-api';
import * as winapi from 'winapi-bindings';

const STORE_ID: string = 'xbox';
const MICROSOFT_PUBLISHER_ID: string = '8wekyb3d8bbwe';

const XBOXAPP_NAME = 'microsoft.xboxapp';

export interface IXboxEntry extends types.IGameStoreEntry {
  packageId: string;
  publisherId: string;
  executionName: string;
}

// List of package naming patterns which are safe to ignore
//  when browsing the package repository.
const IGNORABLE: string[] = [
  'microsoft.accounts', 'microsoft.aad', 'microsoft.advertising', 'microsoft.bing', 'microsoft.desktop',
  'microsoft.directx', 'microsoft.gethelp', 'microsoft.getstarted', 'microsoft.hefi', 'microsoft.lockapp',
  'microsoft.microsoft', 'microsoft.net', 'microsoft.office', 'microsoft.oneconnect', 'microsoft.services',
  'microsoft.ui', 'microsoft.vclibs', 'microsoft.windows', 'microsoft.xbox', 'microsoft.zune', 'nvidiacorp',
  'realtek', 'samsung', 'synapticsincorporated', 'windows',
];

// Generally contains all game specific information.
//  Please note: Package display name might not be resolved correctly.
const REPOSITORY_PATH: string = 'Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';

// Registry key path pattern pointing to a package's resources.
//  Xbox app will always have an entry for a package inside C:\Program Files\WindowsApps
//  even when installed to a different partition (Windows creates symlinks).
const RESOURCES_PATH: string = 'Local Settings\\MrtCache\\C:%5CProgram Files%5CWindowsApps%5C{{PACKAGE_ID}}%5Cresources.pri';

// Pattern to retrieve a game entry's display name. Should only be used to extract the
//  display name from the resources path, and even then only if we can't resolve the
//  name from the PACKAGE_REPO key.
const APP_DISPLAY_NAME: string = '@{{{PACKAGE_ID}}?ms-resource://{{APP_ID}}/resources/AppDisplayName}';

/**
 * base class to interact with local Uplay game store.
 * @class UPlayLauncher
 */
class XboxLauncher implements types.IGameStore {
  public id: string;
  private isXboxInstalled: boolean;
  private mCache: Promise<IXboxEntry[]>;

  constructor() {
    this.id = STORE_ID;
    this.isXboxInstalled = false;
    if (process.platform === 'win32') {
      // No Windows, no xbox launcher!
      try {
        winapi.WithRegOpen('HKEY_CLASSES_ROOT', REPOSITORY_PATH, hkey => {
          const keys = winapi.RegEnumKeys(hkey).map(key => key.key.toLowerCase());
          this.isXboxInstalled = keys.find(key => key.startsWith(XBOXAPP_NAME)) !== undefined;
        });
      } catch (err) {
        log('info', 'xbox launcher not found', { error: err.message });
      }
    } else {
      log('info', 'xbox launcher not found', { error: 'only available on Windows systems' });
    }
  }

  // To successfully launch an Xbox game through the app we need to assemble
  //  the execution command which consists of:
  //  - Explorer shell command (this will not change)
  //  - Identity
  //  - PunlisherId
  //  - The game/app "executable"
  // e.g. explorer.exe shell:appsFolder\\SystemEraSoftworks.29415440E1269_ftk5pbg2rayv2!ASTRONEER
  public launchGame(appInfo: any, api?: types.IExtensionApi): Promise<void> {
    if (!appInfo) {
      return Promise.reject(new util.ArgumentInvalid('appInfo is undefined/null'));
    }

    return this.findByAppId(appInfo).then(entry => {
      const launchCommand = `explorer.exe shell:appsFolder\\${(entry as any).appid}_${entry.publisherId}!${entry.executionName}`;
      log('debug', 'launching game through xbox store', launchCommand);
      return util.opn(launchCommand).catch(err => Promise.resolve());
    });
  }

  /**
   * find the first game with the specified appid or one of the specified appids
   */
  public findByAppId(appId: string): Promise<IXboxEntry> {
    return this.allGames()
      .then(entries => {
        const gameEntry = entries.find(entry => (entry as any).appid === appId);
        if (gameEntry === undefined) {
          return Promise.reject(
            new types.GameEntryNotFound(Array.isArray(appId) ? appId.join(', ') : appId, STORE_ID));
        } else {
          return Promise.resolve(gameEntry);
        }
      });
  }

  public allGames(): Promise<IXboxEntry[]> {
    if (!this.mCache && this.isXboxInstalled) {
      this.mCache = this.getGameEntries();
    }
    return this.mCache;
  }

  private getFirstKeyName(rootKey: winapi.REGISTRY_HIVE, keyPath: string): string {
    const keyNames = this.getKeyNames(rootKey, keyPath);
    return keyNames.length > 0 ? keyNames[0] : undefined;
  }

  // Please note that the filterList is aimed at EXCLUDING/IGNORING the provided strings.
  private getKeyNames(rootKey: winapi.REGISTRY_HIVE, keyPath: string, filterList?: string[]): string[] {
    let keyNames: string[] = [];
    try {
      winapi.WithRegOpen(rootKey, keyPath, hkey => {
        const names = winapi.RegEnumKeys(hkey);
        keyNames = ((!!filterList)
          ? names.filter(key => filterList.find(ign => key.key.toLowerCase().startsWith(ign)) === undefined)
          : names).map(key => key.key);
      });
    } catch (err) {
      log('error', 'unable to retrieve key names', keyPath);
    }

    return keyNames;
  }

  // Given the registry path we're using to find game entries
  //  there's a high probability we will create entries for regular Microsoft
  //  store apps as well as Xbox games. At the time of creation, we were not
  //  able to find a cleaner registry path, and therefore will have to filter
  //  ignorable packages using the IGNORABLE array we defined at the top of
  //  this script.
  private getGameEntries(): Promise<IXboxEntry[]> {
    return new Promise<IXboxEntry[]>((resolve, reject) => {
      try {
        winapi.WithRegOpen('HKEY_CLASSES_ROOT', REPOSITORY_PATH, hkey => {
          const keys: string[] = winapi.RegEnumKeys(hkey)
            .filter(key => IGNORABLE.find(ign => key.key.toLowerCase().startsWith(ign)) === undefined)
            .map(key => key.key);
          const gameEntries: IXboxEntry[] = keys.map(key => {
            // The full package id containing an entry's identity, version and publisher id.
            const packageId = key;

            const firstKeyName: string = this.getFirstKeyName('HKEY_CLASSES_ROOT', path.join(REPOSITORY_PATH, key));
            const executionName: string = !!firstKeyName ? firstKeyName : 'App';

            // Publisher id is expected to be at the very end of the key,
            //  following the last underscore in the entry's name.
            const publisherId: string = key.substr(key.lastIndexOf('_') + 1);

            // The App's identity is separated from the rest of the entry using
            //  the first encountered underscore.
            const appid: string = key.substring(0, key.indexOf('_'));

            // Will store the game's name once we're able to find it...
            let name: string;

            // Display name entry is generally resolved to the game's actual name
            //  but might be pointing towards a different key in registry...
            const displayName: string = winapi.RegGetValue('HKEY_CLASSES_ROOT', REPOSITORY_PATH + '\\' + key, 'DisplayName').value as string;
            if (displayName.startsWith('@')) {
              // Lets try and resolve this nightmare.
              const cachePath: string = RESOURCES_PATH.replace('{{PACKAGE_ID}}', packageId);
              const firstKey: string = this.getFirstKeyName('HKEY_CLASSES_ROOT', cachePath);
              if (!firstKey) {
                return undefined;
              }
              const hivesPath: string = path.join(cachePath, firstKey);
              const hives: string[] = this.getKeyNames('HKEY_CLASSES_ROOT', hivesPath);
              if (hives.length === 0) {
                return undefined;
              }

              hives.forEach(hive => {
                try {
                  const namePath: string = path.join(hivesPath, hive);
                  winapi.WithRegOpen('HKEY_CLASSES_ROOT', namePath, secondhkey => {
                    const values: string[] = winapi.RegEnumValues(secondhkey).map(val => val.key);
                    if (values.indexOf(displayName) !== -1) {
                      name = winapi.RegGetValue('HKEY_CLASSES_ROOT', namePath, displayName).value as string;
                    }
                  });
                } catch (err) {
                  return undefined;
                }
              });
            } else {
              // easy.
              name = displayName;
            }

            // This should be an IXboxEntry instead of "any" but tslint is being
            //  retarded and can't deduce that IXboxEntry extends IGameStoreEntry
            const gameEntry: any = {
              appid,
              publisherId,
              executionName,
              gamePath: winapi.RegGetValue(hkey, key, 'PackageRootFolder').value as string,
              name,
              gameStoreId: STORE_ID,
            };
            return gameEntry;
          });
          return resolve(gameEntries.filter(entry => !!entry));
        });
      } catch (err) {
        return reject(err);
      }
    });
  }
}

function main(context: types.IExtensionContext) {
  const instance: types.IGameStore =
    process.platform === 'win32' ? new XboxLauncher() : undefined;

  if (instance !== undefined) {
    context.registerGameStore(instance);
  }

  return true;
}

export default main;
