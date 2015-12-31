 /**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */
'use strict';

const Fastfs = require('../fastfs');
const ModuleCache = require('../ModuleCache');
const Promise = require('promise');
const crawl = require('../crawlers');
const getPlatformExtension = require('../lib/getPlatformExtension');
const isAbsolutePath = require('absolute-path');
const path = require('path');
const util = require('util');
const Helpers = require('./Helpers');
const ResolutionRequest = require('./ResolutionRequest');
const ResolutionResponse = require('./ResolutionResponse');
const HasteMap = require('./HasteMap');
const DeprecatedAssetMap = require('./DeprecatedAssetMap');

const defaultActivity = {
  startEvent: () => {},
  endEvent: () => {},
};

class DependencyGraph {
  constructor({
    activity,
    roots,
    ignoreFilePath,
    fileWatcher,
    assetRoots_DEPRECATED,
    assetExts,
    providesModuleNodeModules,
    platforms,
    cache,
    extensions,
    mocksPattern,
    extractRequires,
  }) {
    this._opts = {
      activity: activity || defaultActivity,
      roots,
      ignoreFilePath: ignoreFilePath || (() => {}),
      fileWatcher,
      assetRoots_DEPRECATED: assetRoots_DEPRECATED || [],
      assetExts: assetExts || [],
      providesModuleNodeModules,
      platforms: platforms || [],
      cache,
      extensions: extensions || ['js', 'json'],
      mocksPattern,
      extractRequires,
    };
    this._cache = this._opts.cache;
    this._helpers = new Helpers(this._opts);
    this.load();
  }

  load() {
    if (this._loading) {
      return this._loading;
    }

    const {activity} = this._opts;
    const depGraphActivity = activity.startEvent('Building Dependency Graph');
    const crawlActivity = activity.startEvent('Crawling File System');
    const allRoots = this._opts.roots.concat(this._opts.assetRoots_DEPRECATED);
    this._crawling = crawl(allRoots, {
      ignore: this._opts.ignoreFilePath,
      exts: this._opts.extensions.concat(this._opts.assetExts),
      fileWatcher: this._opts.fileWatcher,
    });
    this._crawling.then((files) => activity.endEvent(crawlActivity));

    this._fastfs = new Fastfs(
      'JavaScript',
      this._opts.roots,
      this._opts.fileWatcher,
      {
        ignore: this._opts.ignoreFilePath,
        crawling: this._crawling,
        activity: activity,
      }
    );

    this._fastfs.on('change', this._processFileChange.bind(this));

    this._moduleCache = new ModuleCache(
      this._fastfs,
      this._cache,
      this._opts.extractRequires
    );

    this._hasteMap = new HasteMap({
      fastfs: this._fastfs,
      extensions: this._opts.extensions,
      moduleCache: this._moduleCache,
      assetExts: this._opts.exts,
      helpers: this._helpers,
    });

    this._deprecatedAssetMap = new DeprecatedAssetMap({
      fsCrawl: this._crawling,
      roots: this._opts.assetRoots_DEPRECATED,
      helpers: this._helpers,
      fileWatcher: this._opts.fileWatcher,
      ignoreFilePath: this._opts.ignoreFilePath,
      assetExts: this._opts.assetExts,
      activity: this._opts.activity,
    });

    this._loading = Promise.all([
      this._fastfs.build()
        .then(() => {
          const hasteActivity = activity.startEvent('Building Haste Map');
          return this._hasteMap.build().then(() => activity.endEvent(hasteActivity));
        }),
      this._deprecatedAssetMap.build(),
    ]).then(() =>
      activity.endEvent(depGraphActivity)
    );

    return this._loading;
  }

  getDependencies(entryPath, platform) {
    return this.load().then(() => {
      platform = this._getRequestPlatform(entryPath, platform);
      const absPath = this._getAbsolutePath(entryPath);
      const req = new ResolutionRequest({
        platform,
        entryPath: absPath,
        deprecatedAssetMap: this._deprecatedAssetMap,
        hasteMap: this._hasteMap,
        helpers: this._helpers,
        moduleCache: this._moduleCache,
        fastfs: this._fastfs,
      });

      const response = new ResolutionResponse();

      return Promise.all([
        req.getOrderedDependencies(response, this._opts.mocksPattern),
        req.getAsyncDependencies(response),
      ]).then(() => response);
    });
  }

  matchFilesByPattern(pattern) {
    return this.load().then(() => this._fastfs.matchFilesByPattern(pattern));
  }

  _getRequestPlatform(entryPath, platform) {
    if (platform == null) {
      platform = getPlatformExtension(entryPath);
      if (platform == null || this._opts.platforms.indexOf(platform) === -1) {
        platform = null;
      }
    } else if (this._opts.platforms.indexOf(platform) === -1) {
      throw new Error('Unrecognized platform: ' + platform);
    }
    return platform;
  }

  _getAbsolutePath(filePath) {
    if (isAbsolutePath(filePath)) {
      return path.resolve(filePath);
    }

    for (let i = 0; i < this._opts.roots.length; i++) {
      const root = this._opts.roots[i];
      const potentialAbsPath = path.join(root, filePath);
      if (this._fastfs.fileExists(potentialAbsPath)) {
        return path.resolve(potentialAbsPath);
      }
    }

    throw new NotFoundError(
      'Cannot find entry file %s in any of the roots: %j',
      filePath,
      this._opts.roots
    );
  }

  _processFileChange(type, filePath, root, fstat) {
    const absPath = path.join(root, filePath);
    if (fstat && fstat.isDirectory() ||
        this._opts.ignoreFilePath(absPath) ||
        this._helpers.isNodeModulesDir(absPath)) {
      return;
    }

    this._loading = this._loading.then(
      () => this._hasteMap.processFileChange(type, absPath)
    );
  }

}

function NotFoundError() {
  Error.call(this);
  Error.captureStackTrace(this, this.constructor);
  var msg = util.format.apply(util, arguments);
  this.message = msg;
  this.type = this.name = 'NotFoundError';
  this.status = 404;
}
util.inherits(NotFoundError, Error);

module.exports = DependencyGraph;
