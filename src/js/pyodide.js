/**
 * The main bootstrap code for loading pyodide.
 */
import { Module, setStandardStreams } from "./module.js";
import {
  loadScript,
  initializePackageIndex,
  loadPackage,
} from "./load-pyodide.js";
import { makePublicAPI, registerJsModule } from "./api.js";
import "./pyproxy.gen.js";

/**
 * @typedef {import('./pyproxy.gen').PyProxy} PyProxy
 * @typedef {import('./pyproxy.gen').PyProxyWithLength} PyProxyWithLength
 * @typedef {import('./pyproxy.gen').PyProxyWithGet} PyProxyWithGet
 * @typedef {import('./pyproxy.gen').PyProxyWithSet} PyProxyWithSet
 * @typedef {import('./pyproxy.gen').PyProxyWithHas} PyProxyWithHas
 * @typedef {import('./pyproxy.gen').PyProxyIterable} PyProxyIterable
 * @typedef {import('./pyproxy.gen').PyProxyIterator} PyProxyIterator
 * @typedef {import('./pyproxy.gen').PyProxyAwaitable} PyProxyAwaitable
 * @typedef {import('./pyproxy.gen').PyProxyBuffer} PyProxyBuffer
 * @typedef {import('./pyproxy.gen').PyProxyCallable} PyProxyCallable
 *
 * @typedef {import('./pyproxy.gen').Py2JsResult} Py2JsResult
 *
 * @typedef {import('./pyproxy.gen').TypedArray} TypedArray
 * @typedef {import('./pyproxy.gen').PyBuffer} PyBuffer
 */

/**
 * Dump the Python traceback to the browser console.
 *
 * @private
 */
Module.dump_traceback = function () {
  let fd_stdout = 1;
  Module.__Py_DumpTraceback(fd_stdout, Module._PyGILState_GetThisThreadState());
};

let fatal_error_occurred = false;
/**
 * Signal a fatal error.
 *
 * Dumps the Python traceback, shows a JavaScript traceback, and prints a clear
 * message indicating a fatal error. It then dummies out the public API so that
 * further attempts to use Pyodide will clearly indicate that Pyodide has failed
 * and can no longer be used. pyodide._module is left accessible and it is
 * possible to continue using Pyodide for debugging purposes if desired.
 *
 * @argument e {Error} The cause of the fatal error.
 * @private
 */
Module.fatal_error = function (e) {
  if (fatal_error_occurred) {
    console.error("Recursive call to fatal_error. Inner error was:");
    console.error(e);
    return;
  }
  fatal_error_occurred = true;
  console.error(
    "Pyodide has suffered a fatal error. Please report this to the Pyodide maintainers."
  );
  console.error("The cause of the fatal error was:");
  if (Module.inTestHoist) {
    // Test hoist won't print the error object in a useful way so convert it to
    // string.
    console.error(e.toString());
    console.error(e.stack);
  } else {
    console.error(e);
  }
  try {
    Module.dump_traceback();
    for (let key of Object.keys(Module.public_api)) {
      if (key.startsWith("_") || key === "version") {
        continue;
      }
      Object.defineProperty(Module.public_api, key, {
        enumerable: true,
        configurable: true,
        get: () => {
          throw new Error(
            "Pyodide already fatally failed and can no longer be used."
          );
        },
      });
    }
    if (Module.on_fatal) {
      Module.on_fatal(e);
    }
  } catch (err2) {
    console.error("Another error occurred while handling the fatal error:");
    console.error(err2);
  }
  throw e;
};

/**
 * Run Python code in the simplest way possible. The primary purpose of this
 * method is for bootstrapping. It is also useful for debugging: If the Python
 * interpreter is initialized successfully then it should be possible to use
 * this method to run Python code even if everything else in the Pyodide
 * `core` module fails.
 *
 * The differences are:
 *    1. `runPythonSimple` doesn't return anything (and so won't leak
 *        PyProxies)
 *    2. `runPythonSimple` doesn't require access to any state on the
 *       JavaScript `pyodide` module.
 *    3. `runPython` uses `pyodide.eval_code`, whereas `runPythonSimple` uses
 *       `PyRun_String` which is the C API for `eval` / `exec`.
 *    4. `runPythonSimple` runs with `globals` a separate dict which is called
 *       `init_dict` (keeps global state private)
 *    5. `runPythonSimple` doesn't dedent the argument
 *
 * When `core` initialization is completed, the globals for `runPythonSimple`
 * is made available as `Module.init_dict`.
 *
 * @private
 */
Module.runPythonSimple = function (code) {
  let code_c_string = Module.stringToNewUTF8(code);
  let errcode;
  try {
    errcode = Module._run_python_simple_inner(code_c_string);
  } catch (e) {
    Module.fatal_error(e);
  } finally {
    Module._free(code_c_string);
  }
  if (errcode === -1) {
    Module._pythonexc2js();
  }
};

/**
 * The JavaScript/Wasm call stack is too small to handle the default Python call
 * stack limit of 1000 frames. Here, we determine the JavaScript call stack
 * depth available, and then divide by 50 (determined heuristically) to set the
 * maximum Python call stack depth.
 *
 * @private
 */
function fixRecursionLimit() {
  let depth = 0;
  function recurse() {
    depth += 1;
    recurse();
  }
  try {
    recurse();
  } catch (err) {}

  let recursionLimit = Math.min(depth / 25, 500);
  Module.runPythonSimple(
    `import sys; sys.setrecursionlimit(int(${recursionLimit}))`
  );
}
/**
 * Load the main Pyodide wasm module and initialize it.
 *
 * Only one copy of Pyodide can be loaded in a given JavaScript global scope
 * because Pyodide uses global variables to load packages. If an attempt is made
 * to load a second copy of Pyodide, :any:`loadPyodide` will throw an error.
 * (This can be fixed once `Firefox adopts support for ES6 modules in webworkers
 * <https://bugzilla.mozilla.org/show_bug.cgi?id=1247687>`_.)
 *
 * @param {string} config.indexURL - The URL from which Pyodide will load
 * packages
 * @param {boolean} config.fullStdLib - Load the full Python standard library.
 * Setting this to false excludes following modules: distutils.
 * Default: true
 * @param {undefined | function(): string} config.stdin - Override the standard input callback. Should ask the user for one line of input.
 * Default: undefined
 * @param {undefined | function(string)} config.stdout - Override the standard output callback.
 * Default: undefined
 * @param {undefined | function(string)} config.stderr - Override the standard error output callback.
 * Default: undefined
 * @returns The :ref:`js-api-pyodide` module.
 * @memberof globalThis
 * @async
 */
export async function loadPyodide(config) {
  const default_config = {
    fullStdLib: true,
    jsglobals: globalThis,
    stdin: globalThis.prompt ? globalThis.prompt : undefined,
  };
  config = Object.assign(default_config, config);
  if (globalThis.__pyodide_module) {
    if (globalThis.languagePluginURL) {
      throw new Error(
        "Pyodide is already loading because languagePluginURL is defined."
      );
    } else {
      throw new Error("Pyodide is already loading.");
    }
  }
  // A global "mount point" for the package loaders to talk to pyodide
  // See "--export-name=__pyodide_module" in buildpkg.py
  globalThis.__pyodide_module = Module;
  loadPyodide.inProgress = true;
  if (!config.indexURL) {
    throw new Error("Please provide indexURL parameter to loadPyodide");
  }
  let baseURL = config.indexURL;
  if (!baseURL.endsWith("/")) {
    baseURL += "/";
  }
  Module.indexURL = baseURL;
  let packageIndexReady = initializePackageIndex(baseURL);

  setStandardStreams(config.stdin, config.stdout, config.stderr);

  Module.locateFile = (path) => baseURL + path;
  let moduleLoaded = new Promise((r) => (Module.postRun = r));

  const scriptSrc = `${baseURL}pyodide.asm.js`;
  await loadScript(scriptSrc);

  // _createPyodideModule is specified in the Makefile by the linker flag:
  // `-s EXPORT_NAME="'_createPyodideModule'"`
  await _createPyodideModule(Module);

  // There is some work to be done between the module being "ready" and postRun
  // being called.
  await moduleLoaded;

  fixRecursionLimit();
  let pyodide = makePublicAPI();

  // Bootstrap steps:
  //
  //   1. _pyodide_core is ready now so we can call _pyodide.register_js_finder
  //   2. Use the jsfinder to register the js and pyodide_js packages
  //   3. Import pyodide, this requires _pyodide_core, js and pyodide_js to be
  //      ready.
  //   4. Add the pyodide_py and Python __main__.__dict__ objects to pyodide_js
  Module.runPythonSimple(`
def temp(pyodide_js, Module, jsglobals):
  from _pyodide._importhook import register_js_finder, register_js_module
  register_js_finder()
  register_js_module("js", jsglobals)
  register_js_module("pyodide_js", pyodide_js)

  import pyodide
  import __main__
  import builtins

  Module.version = pyodide.__version__
  Module.globals = __main__.__dict__
  Module.builtins = builtins.__dict__
  Module.pyodide_py = pyodide
  print("Python initialization complete")
`);

  Module.init_dict.get("temp")(pyodide, Module, config.jsglobals);
  // Module.runPython works starting from here!

  pyodide.globals = new Proxy(Module.globals, {
    get(target, symbol) {
      if (symbol === "get") {
        return (key) => {
          let result = target.get(key);
          if (result === undefined) {
            result = Module.builtins.get(key);
          }
          return result;
        };
      }
      if (symbol === "has") {
        return (key) => target.has(key) || Module.builtins.has(key);
      }
      return Reflect.get(target, symbol);
    },
  });
  pyodide.pyodide_py = Module.pyodide_py;
  pyodide.version = Module.version;

  await packageIndexReady;
  if (config.fullStdLib) {
    await loadPackage(["distutils"]);
  }

  return pyodide;
}
globalThis.loadPyodide = loadPyodide;
