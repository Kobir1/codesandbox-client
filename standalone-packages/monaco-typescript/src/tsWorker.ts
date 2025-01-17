/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as ts from './lib/typescriptServices';
import { lib_dts, lib_es6_dts } from './lib/lib';
import * as fetchTypings from './fetchDependencyTypings';

import Promise = monaco.Promise;
import IWorkerContext = monaco.worker.IWorkerContext;

const DEFAULT_LIB = {
	NAME: 'defaultLib:lib.d.ts',
	CONTENTS: lib_dts
};

const ES6_LIB = {
	NAME: 'defaultLib:lib.es6.d.ts',
	CONTENTS: lib_es6_dts
};

declare global {
  interface Window { BrowserFS: any; }
}

// Quickly remove amd so BrowserFS will register to global scope instead.
// @ts-ignore
const oldamd = self.define.amd;
(self as any).define.amd = null;
(self as any).importScripts(
  `/static/browserfs2/browserfs.min.js`
);
(self as any).define.amd = oldamd;

(self as any).BrowserFS = BrowserFS;
(self as any).process = BrowserFS.BFSRequire('process');
(self as any).Buffer = BrowserFS.BFSRequire('buffer').Buffer;


const getAllFiles = (fs: any, dir: string, filelist?: string[]) => {
  if (!fs) {
    return [];
  }

  const files = fs.readdirSync(dir);
  filelist = filelist || [];
  files.forEach(function(file) {
    if (fs.statSync(dir + file).isDirectory()) {
      filelist = getAllFiles(fs, dir + file + '/', filelist);
    } else {
      filelist.push(dir + file);
    }
  });
  return filelist;
}

export class TypeScriptWorker implements ts.LanguageServiceHost {

	// --- model sync -----------------------

	private _ctx: IWorkerContext;
	private _extraLibs: { [fileName: string]: string } = Object.create(null);
	private _languageService = ts.createLanguageService(this);
  private _compilerOptions: ts.CompilerOptions;

  private fs: any;
  private files: {[path: string]: string} = {};
  private typesLoaded: boolean = false;

	constructor(ctx: IWorkerContext, createData: ICreateData) {
		this._ctx = ctx;
		this._compilerOptions = createData.compilerOptions;
    this._extraLibs = createData.extraLibs;

    ctx.onModelRemoved((str) => {
      const p = str.indexOf('file://') === 0 ? monaco.Uri.parse(str).fsPath : str;

      this.syncFile(p);
    })

    self.BrowserFS.configure(
      {
        fs: 'WorkerFS', options: { worker: self },
      },
      e => {
        if (e) {
          console.error(e);
          return;
        }

        this.fs = BrowserFS.BFSRequire('fs');

        this.syncDirectory('/sandbox');

        this.getTypings();
        setInterval(() => this.getTypings(), 5000);

        // BrowserFS is initialized and ready-to-use!
      }
    );
  }

  getTypings() {
    const ensureDirectoryExistence = (filePath, cb) => {
      const dirname = BrowserFS.BFSRequire('path').dirname(filePath);
      this.fs.stat(dirname, (err, exists) => {
        if (!!exists) {
          cb(true);
          return;
        }

        ensureDirectoryExistence(dirname, () => {
          this.fs.mkdir(dirname, cb);
        });
      });
    }

    this.fs.readFile('/sandbox/package.json', (e, data) => {
      if (e) {
        return;
      }

      const code = data.toString();
      try {
        const p = JSON.parse(code);

        fetchTypings.fetchAndAddDependencies(p.dependencies, (paths) => {
          Object.keys(paths).forEach(p => {
            const pathToWrite = '/sandbox/' + p;
            this.files[pathToWrite] = paths[p];

            ensureDirectoryExistence(pathToWrite, () => {
              this.fs.writeFile(pathToWrite, paths[p], () => {});
            });
          })
        }).then(() => {
          this.typesLoaded = true;
          this._languageService.cleanupSemanticCache();
        });
      } catch (e) {
        return
      }
    })
  }

  syncFile(path: string) {
    this.fs.readFile(path, (e, str) => {
      if (e) {
        delete this.files[path];
        throw e;
      }

      this.files[path] = str.toString();
    })
  }

  syncDirectory(path: string) {
    this.fs.readdir(path, (e, entries) => {
      if (e) throw e;

      entries.forEach(entry => {
        const fullEntry = path + '/' + entry;
        this.fs.stat(fullEntry, (err, stat) => {
          if (err) {
            throw err;
          }

          if (stat.isDirectory()) {
            this.syncDirectory(fullEntry);
          } else {
            this.syncFile(fullEntry);
          }
        })
      })
    })

  }

	// --- language service host ---------------

	getCompilationSettings(): ts.CompilerOptions {
		return this._compilerOptions;
  }

  readFile(resource: string, encoding?: string) {
    const path = resource.indexOf('file://') === 0 ? monaco.Uri.parse(resource).fsPath : resource;
    if (this.fs) {
      return this.files[path];
    }

    return undefined;
  }

	getScriptFileNames(): string[] {
		let models = this._ctx.getMirrorModels().map(model => model.uri.toString());
		return models.concat(Object.keys(this._extraLibs)).concat(Object.keys(this.files).map(p => `file://${p}`));
	}

	private _getModel(fileName: string): monaco.worker.IMirrorModel {
		let models = this._ctx.getMirrorModels();
		for (let i = 0; i < models.length; i++) {
			if (models[i].uri.toString() === fileName) {
				return models[i];
			}
		}
		return null;
	}

	getScriptVersion(fileName: string): string {
		let model = this._getModel(fileName);
		if (model) {
			return model.version.toString();
		} else if (this.isDefaultLibFileName(fileName) || fileName in this._extraLibs) {
			// extra lib and default lib are static
			return '1';
		}
	}

	getScriptSnapshot(fileName: string): ts.IScriptSnapshot {
		let text: string;
    let model = this._getModel(fileName);

		if (model) {
			// a true editor model
			text = model.getValue();

		} else if (fileName in this._extraLibs) {
			// static extra lib
			text = this._extraLibs[fileName];

		} else if (fileName === DEFAULT_LIB.NAME) {
			text = DEFAULT_LIB.CONTENTS;
		} else if (fileName === ES6_LIB.NAME) {
			text = ES6_LIB.CONTENTS;
		} else if (this.fs) {
      const usedFilename = fileName.indexOf('file://') === 0 ? monaco.Uri.parse(fileName).fsPath : fileName;
      text = this.files[usedFilename];
		} else {
      return;
    }

    if (text == null) {
      return;
    }

		return <ts.IScriptSnapshot>{
			getText: (start, end) => text.substring(start, end),
			getLength: () => text.length,
			getChangeRange: () => undefined
		};
	}

	getScriptKind?(fileName: string): ts.ScriptKind {
		const suffix = fileName.substr(fileName.lastIndexOf('.') + 1);
		switch (suffix) {
			case 'ts': return ts.ScriptKind.TS;
			case 'tsx': return ts.ScriptKind.TSX;
			case 'js': return ts.ScriptKind.JS;
			case 'jsx': return ts.ScriptKind.JSX;
			default: return this.getCompilationSettings().allowJs
				? ts.ScriptKind.JS
				: ts.ScriptKind.TS;
		}
	}

	getCurrentDirectory(): string {
		return '/sandbox';
	}

	getDefaultLibFileName(options: ts.CompilerOptions): string {
		// TODO@joh support lib.es7.d.ts
		return options.target <= ts.ScriptTarget.ES5 ? DEFAULT_LIB.NAME : ES6_LIB.NAME;
	}

	isDefaultLibFileName(fileName: string): boolean {
		return fileName === this.getDefaultLibFileName(this._compilerOptions);
  }

  fileExists(resource: string) {
    if (!this.fs) {
      return false;
    }
    const path = resource.indexOf('file://') === 0 ? monaco.Uri.parse(resource).fsPath : resource;
    return this.files[path] !== undefined;
  }

  directoryExists(resource: string) {
    if (!this.fs) {
      return false;
    }
    const path = resource.indexOf('file://') === 0 ? monaco.Uri.parse(resource).fsPath : resource;
    return Object.keys(this.files).some(f => f.indexOf(path) === 0);
  }

  getDirectories(resource: string) {
    if (!this.fs) {
      return [];
    }
    const path = resource.indexOf('file://') === 0 ? monaco.Uri.parse(resource).fsPath : resource;
    const resourceSplits = path.split('/').length;
    return Object.keys(this.files).filter(f => f.indexOf(path) === 0).map(p => {
      const newP = p.split('/');
      newP.length = resourceSplits;

      return newP[newP.length - 1];
    });
  }


	// --- language features

	private static clearFiles(diagnostics: ts.Diagnostic[]) {
		// Clear the `file` field, which cannot be JSON'yfied because it
		// contains cyclic data structures.
		diagnostics.forEach(diag => {
			diag.file = undefined;
			const related = <ts.Diagnostic[]>diag.relatedInformation;
			if (related) {
				related.forEach(diag2 => diag2.file = undefined);
			}
		});
	}

	getSyntacticDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
    if (!this.typesLoaded) {
      return Promise.as([]);
    }

		const diagnostics = this._languageService.getSyntacticDiagnostics(fileName);
		TypeScriptWorker.clearFiles(diagnostics);
		return Promise.as(diagnostics);
	}

	getSemanticDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
    if (!this.typesLoaded) {
      return Promise.as([]);
    }

		const diagnostics = this._languageService.getSemanticDiagnostics(fileName);
		TypeScriptWorker.clearFiles(diagnostics);
		return Promise.as(diagnostics);
	}

	getCompilerOptionsDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
		const diagnostics = this._languageService.getCompilerOptionsDiagnostics();
		TypeScriptWorker.clearFiles(diagnostics);
		return Promise.as(diagnostics);
	}

	getCompletionsAtPosition(fileName: string, position: number): Promise<ts.CompletionInfo> {
		return Promise.as(this._languageService.getCompletionsAtPosition(fileName, position, undefined));
	}

	getCompletionEntryDetails(fileName: string, position: number, entry: string): Promise<ts.CompletionEntryDetails> {
		return Promise.as(this._languageService.getCompletionEntryDetails(fileName, position, entry, undefined, undefined, undefined));
	}

	getSignatureHelpItems(fileName: string, position: number): Promise<ts.SignatureHelpItems> {
		return Promise.as(this._languageService.getSignatureHelpItems(fileName, position, undefined));
	}

	getQuickInfoAtPosition(fileName: string, position: number): Promise<ts.QuickInfo> {
		return Promise.as(this._languageService.getQuickInfoAtPosition(fileName, position));
	}

	getOccurrencesAtPosition(fileName: string, position: number): Promise<ts.ReferenceEntry[]> {
		return Promise.as(this._languageService.getOccurrencesAtPosition(fileName, position));
	}

	getDefinitionAtPosition(fileName: string, position: number): Promise<ts.DefinitionInfo[]> {
		return Promise.as(this._languageService.getDefinitionAtPosition(fileName, position));
	}

	getReferencesAtPosition(fileName: string, position: number): Promise<ts.ReferenceEntry[]> {
		return Promise.as(this._languageService.getReferencesAtPosition(fileName, position));
	}

	getNavigationBarItems(fileName: string): Promise<ts.NavigationBarItem[]> {
		return Promise.as(this._languageService.getNavigationBarItems(fileName));
	}

	getFormattingEditsForDocument(fileName: string, options: ts.FormatCodeOptions): Promise<ts.TextChange[]> {
		return Promise.as(this._languageService.getFormattingEditsForDocument(fileName, options));
	}

	getFormattingEditsForRange(fileName: string, start: number, end: number, options: ts.FormatCodeOptions): Promise<ts.TextChange[]> {
		return Promise.as(this._languageService.getFormattingEditsForRange(fileName, start, end, options));
	}

	getFormattingEditsAfterKeystroke(fileName: string, postion: number, ch: string, options: ts.FormatCodeOptions): Promise<ts.TextChange[]> {
		return Promise.as(this._languageService.getFormattingEditsAfterKeystroke(fileName, postion, ch, options));
	}

	getEmitOutput(fileName: string): Promise<ts.EmitOutput> {
		return Promise.as(this._languageService.getEmitOutput(fileName));
	}
}

export interface ICreateData {
	compilerOptions: ts.CompilerOptions;
	extraLibs: { [path: string]: string };
}

export function create(ctx: IWorkerContext, createData: ICreateData): TypeScriptWorker {
	return new TypeScriptWorker(ctx, createData);
}
