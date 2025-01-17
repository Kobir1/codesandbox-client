/* eslint-disable no-param-reassign */
import * as ts from "./lib/typescriptServices";

const splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;

function splitPath(filename: string) {
  return splitPathRe.exec(filename).slice(1);
}

// resolves . and .. elements in a path array with directory names there
// must be no slashes or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  const res = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];

    // ignore empty parts
    if (!p || p === ".") continue; // eslint-disable-line no-continue

    if (p === "..") {
      if (res.length && res[res.length - 1] !== "..") {
        res.pop();
      } else if (allowAboveRoot) {
        res.push("..");
      }
    } else {
      res.push(p);
    }
  }

  return res;
}

export function isAbsolute(path: string) {
  return path.charAt(0) === "/";
}

export function normalize(path: string) {
  const isAbs = isAbsolute(path);
  const trailingSlash = path && path[path.length - 1] === "/";
  let newPath = path;

  // Normalize the path
  newPath = normalizeArray(newPath.split("/"), !isAbs).join("/");

  if (!newPath && !isAbs) {
    newPath = ".";
  }
  if (newPath && trailingSlash) {
    newPath += "/";
  }

  return (isAbs ? "/" : "") + newPath;
}

export function join(...paths: Array<any>) {
  let path = "";
  for (let i = 0; i < paths.length; i += 1) {
    const segment = paths[i];

    if (typeof segment !== "string") {
      throw new TypeError("Arguments to path.join must be strings");
    }
    if (segment) {
      if (!path) {
        path += segment;
      } else {
        path += `/${segment}`;
      }
    }
  }
  return normalize(path);
}

export function dirname(path: string) {
  const result = splitPath(path);
  const root = result[0];
  let dir = result[1];

  if (!root && !dir) {
    // No dirname whatsoever
    return ".";
  }

  if (dir) {
    // It has a dirname, strip trailing slash
    dir = dir.substr(0, dir.length - 1);
  }

  return root + dir;
}

export function basename(p: string, ext: string = "") {
  // Special case: Normalize will modify this to '.'
  if (p === "") {
    return p;
  }
  // Normalize the string first to remove any weirdness.
  const path = normalize(p);
  // Get the last part of the string.
  const sections = path.split("/");
  const lastPart = sections[sections.length - 1];
  // Special case: If it's empty, then we have a string like so: foo/
  // Meaning, 'foo' is guaranteed to be a directory.
  if (lastPart === "" && sections.length > 1) {
    return sections[sections.length - 2];
  }
  // Remove the extension, if need be.
  if (ext.length > 0) {
    const lastPartExt = lastPart.substr(lastPart.length - ext.length);
    if (lastPartExt === ext) {
      return lastPart.substr(0, lastPart.length - ext.length);
    }
  }
  return lastPart;
}

export function absolute(path: string) {
  if (path.indexOf("/") === 0) {
    return path;
  }

  if (path.indexOf("./") === 0) {
    return path.replace("./", "/");
  }

  return "/" + path;
}

const ROOT_URL = `https://cdn.jsdelivr.net/`;
const loadedTypings = [];

/**
 * Send the typings library to the editor, the editor can then add them to the
 * registry
 * @param {string} virtualPath Path of typings
 * @param {string} typings Typings
 */
const addLib = (virtualPath, typings, fetchedPaths) => {
  fetchedPaths[virtualPath] = typings;
};

const fetchCache = new Map();

const doFetch = url => {
  const cached = fetchCache.get(url);
  if (cached) {
    return cached;
  }

  const promise = fetch(url)
    .then(response => {
      if (response.status >= 200 && response.status < 300) {
        return Promise.resolve(response);
      }

      const error = new Error(response.statusText || `${response.status}`);
      // @ts-ignore
      error.response = response;
      return Promise.reject(error);
    })
    .then(response => response.text());

  fetchCache.set(url, promise);
  return promise;
};

const fetchFromDefinitelyTyped = (dependency, version, fetchedPaths) => {
  const depUrl = `${ROOT_URL}npm/@types/${dependency
    .replace("@", "")
    .replace(/\//g, "__")}`;

  return doFetch(`${depUrl}/package.json`).then(async typings => {
    const rootVirtualPath = `node_modules/@types/${dependency}`;
    const referencedPath = `${rootVirtualPath}/package.json`;
    addLib(referencedPath, typings, fetchedPaths);

    // const typeVersion = await doFetch(`${depUrl}/package.json`).then(res => {
    //   const packagePath = `${rootVirtualPath}/package.json`;
    //   addLib(packagePath, res, fetchedPaths);
    //   return JSON.parse(res).version;
    // })

    // get all files in the specified directory
    return getFileMetaData(
      `@types/${dependency}`,
      JSON.parse(typings).version,
      "/"
    ).then(fileData =>
      getFileTypes(
        depUrl,
        `@types/${dependency}`,
        "/index.d.ts",
        fetchedPaths,
        fileData
      )
    );
  });
};

const getRequireStatements = (title: string, code: string) => {
  const requires = [];

  const sourceFile = ts.createSourceFile(
    title,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  // Check the reference comments
  sourceFile.referencedFiles.forEach(ref => {
    requires.push(ref.fileName);
  });

  ts.forEachChild(sourceFile, node => {
    switch (node.kind) {
      case ts.SyntaxKind.ImportDeclaration: {
        // @ts-ignore
        if (node.moduleSpecifier) {
          // @ts-ignore
          requires.push(node.moduleSpecifier.text);
        }
        break;
      }
      case ts.SyntaxKind.ExportDeclaration: {
        // For syntax 'export ... from '...'''
        // @ts-ignore
        if (node.moduleSpecifier) {
          // @ts-ignore
          requires.push(node.moduleSpecifier.text);
        }
        break;
      }
      default: {
        /* */
      }
    }
  });

  return requires;
};

const tempTransformFiles = files => {
  const finalObj = {};

  files.forEach(d => {
    finalObj[d.name] = d;
  });

  return finalObj;
};

const transformFiles = dir =>
  dir.files
    ? dir.files.reduce((prev, next) => {
        if (next.type === "file") {
          return { ...prev, [next.path]: next };
        }

        return { ...prev, ...transformFiles(next) };
      }, {})
    : {};

const getFileMetaData = (dependency, version, depPath) =>
  doFetch(
    `https://data.jsdelivr.com/v1/package/npm/${dependency}@${version}/flat`
  )
    .then(response => JSON.parse(response))
    .then(response => response.files.filter(f => f.name.startsWith(depPath)))
    .then(tempTransformFiles);

const resolveAppropiateFile = (fileMetaData, relativePath) => {
  const absolutePath = `/${relativePath}`;

  if (fileMetaData[`${absolutePath}.d.ts`]) return `${relativePath}.d.ts`;
  if (fileMetaData[`${absolutePath}.ts`]) return `${relativePath}.ts`;
  if (fileMetaData[absolutePath]) return relativePath;
  if (fileMetaData[`${absolutePath}/index.d.ts`])
    return `${relativePath}/index.d.ts`;

  return relativePath;
};

const getFileTypes = (
  depUrl,
  dependency,
  depPath,
  fetchedPaths,
  fileMetaData
) => {
  const virtualPath = join("node_modules", dependency, depPath);

  if (fetchedPaths[virtualPath]) return null;

  return doFetch(`${depUrl}/${depPath}`).then(typings => {
    if (fetchedPaths[virtualPath]) return null;

    addLib(virtualPath, typings, fetchedPaths);

    const requireStatements = getRequireStatements(depPath, typings);

    const isNoDependency = dep => dep.startsWith(".") || dep.endsWith(".d.ts");

    const dependencies = requireStatements
      .filter(x => !isNoDependency(x))
      .reduce(
        (p, n) => ({
          ...p,
          [n]: "latest"
        }),
        {}
      );

    // Now find all require statements, so we can download those types too
    return Promise.all(
      [
        fetchAndAddDependencies(dependencies, () => {}, fetchedPaths).catch(
          () => {
            /* ignore */
          }
        )
      ].concat(
        requireStatements
          .filter(
            // Don't add global deps, only if those are typing files as they are often relative
            isNoDependency
          )
          .map(relativePath => join(dirname(depPath), relativePath))
          .map(relativePath =>
            resolveAppropiateFile(fileMetaData, relativePath)
          )
          .map(nextDepPath =>
            getFileTypes(
              depUrl,
              dependency,
              nextDepPath,
              fetchedPaths,
              fileMetaData
            )
          )
      )
    );
  });
};

function fetchFromMeta(dependency, version, fetchedPaths) {
  const depUrl = `https://data.jsdelivr.com/v1/package/npm/${dependency}@${version}/flat`;
  return doFetch(depUrl)
    .then(response => JSON.parse(response))
    .then(meta => {
      const filterAndFlatten = (files, filter) =>
        files.reduce((paths, file) => {
          if (filter.test(file.name)) {
            paths.push(file.name);
          }
          return paths;
        }, []);

      let dtsFiles = filterAndFlatten(meta.files, /\.d\.ts$/);
      if (dtsFiles.length === 0) {
        // if no .d.ts files found, fallback to .ts files
        dtsFiles = filterAndFlatten(meta.files, /\.ts$/);
      }

      if (dtsFiles.length === 0) {
        throw new Error("No inline typings found.");
      }

      return Promise.all(
        dtsFiles.map(file =>
          doFetch(
            `https://cdn.jsdelivr.net/npm/${dependency}@${version}${file}`
          )
            .then(dtsFile =>
              addLib(`node_modules/${dependency}${file}`, dtsFile, fetchedPaths)
            )
            .catch(() => {})
        )
      );
    });
}

function fetchFromTypings(dependency, version, fetchedPaths) {
  const depUrl = `${ROOT_URL}npm/${dependency}@${version}`;
  return doFetch(`${depUrl}/package.json`)
    .then(response => JSON.parse(response))
    .then(packageJSON => {
      const types = packageJSON.typings || packageJSON.types;
      if (types) {
        // Add package.json, since this defines where all types lie
        addLib(
          `node_modules/${dependency}/package.json`,
          JSON.stringify(packageJSON),
          fetchedPaths
        );

        // get all files in the specified directory
        return getFileMetaData(
          dependency,
          version,
          join("/", dirname(types))
        ).then(fileData =>
          getFileTypes(
            depUrl,
            dependency,
            resolveAppropiateFile(fileData, types),
            fetchedPaths,
            fileData
          )
        );
      }

      throw new Error("No typings field in package.json");
    });
}

export async function fetchAndAddDependencies(
  dependencies,
  onDependencies,
  fetchedPaths = {}
) {
  const depNames = Object.keys(dependencies);

  await Promise.all(
    depNames.map(async dep => {
      try {
        if (loadedTypings.indexOf(dep) === -1) {
          loadedTypings.push(dep);

          const depVersion = await doFetch(
            `https://data.jsdelivr.com/v1/package/resolve/npm/${dep}@${
              dependencies[dep]
            }`
          )
            .then(x => JSON.parse(x))
            .then(x => x.version);
          // eslint-disable-next-line no-await-in-loop
          await fetchFromTypings(dep, depVersion, fetchedPaths).catch(() =>
            // not available in package.json, try checking meta for inline .d.ts files
            fetchFromMeta(dep, depVersion, fetchedPaths).catch(() =>
              // Not available in package.json or inline from meta, try checking in @types/
              fetchFromDefinitelyTyped(dep, depVersion, fetchedPaths)
            )
          );
        }
      } catch (e) {
        // // Don't show these cryptic messages to users, because this is not vital
        // if (process.env.NODE_ENV === 'development') {
        //   console.error(`Couldn't find typings for ${dep}`, e);
        // }
      }
    })
  );

  onDependencies(fetchedPaths);
}
