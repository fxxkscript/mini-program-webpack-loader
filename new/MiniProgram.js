const { existsSync, readFileSync } = require('fs')
const {
  dirname,
  join,
  relative,
  extname,
  basename
} = require('path')
const utils = require('./utils')
const AliPluginHelper = require('./ali/plugin')
const WxPluginHelper = require('./wx/plugin')
const FileTree = require('./FileTree')
const { ProgressPlugin } = require('webpack')
const loader = require('./loader')
const MiniTemplate = require('./MiniTemplate')
const {
  NodeJsInputFileSystem,
  CachedInputFileSystem,
  ResolverFactory
} = require('enhanced-resolve')
const { ConcatSource, RawSource } = require('webpack-sources')
const MultiEntryPlugin = require('webpack/lib/MultiEntryPlugin')
const SingleEntryPlugin = require('webpack/lib/SingleEntryPlugin')

const {
  flattenDeep,
  getFiles,
  componentFiles
} = require('./utils')

const { resolveFilesForPlugin } = require('./helpers/component')

const defaultOptions = {
  extfile: true,
  commonSubPackages: true,
  analyze: false,
  resources: [],
  compilationFinish: null
}

const mainChunkNameTemplate = '__assets_chunk_name__'
let mainChunkNameIndex = 0

module.exports = class MiniProgam {
  constructor (options) {
    this.chunkNames = ['main']

    this.options = Object.assign(
      defaultOptions,
      options
    )

    this.appJsonCode = {
      pages: [],
      subPackages: [],
      plugins: {},
      preloadRule: {},
      usingComponents: {}
    }

    this.filesSet = new Set()
    this.pagesSet = new Set()
    this.componentSet = new Set()
    this.subpackageMap = new Map()
    this.xmlDepsMap = new Map()
    this.fileTree = new FileTree()

    this.helperPlugin = this.options.target === 'ali' ? new AliPluginHelper(this) : new WxPluginHelper(this)
  }

  apply (compiler) {
    this.compiler = compiler
    this.outputPath = compiler.options.output.path
    this.compilerContext = join(compiler.context, 'src')

    // 向 loader 中传递插件实例
    loader.$applyPluginInstance(this)

    // 使用模板插件，用于设置输出格式
    new MiniTemplate(this).apply(compiler)
    new ProgressPlugin({ handler: this.progress }).apply(compiler)

    this.helperPlugin.apply(compiler)

    this.createResolver(compiler)

    this.miniEntrys = utils.formatEntry(compiler.context, compiler.options.entry, this.chunkNames)

    // 计算打包后路径（在 loader 中有使用）
    this.getDistFilePath = utils.getDistPath(this.compilerContext, this.miniEntrys, this.options.resources, this.outputPath)
  }

  createResolver (compiler) {
    const resolver = ResolverFactory.createResolver(
      Object.assign(
        {
          fileSystem: new CachedInputFileSystem(new NodeJsInputFileSystem(), 4000),
          extensions: ['.js', '.json']
        },
        compiler.options.resolve
      )
    )

    this.resolver = (context, request) => {
      return new Promise((resolve, reject) => {
        resolver.resolve({}, context, request, {}, (err, res) => err ? reject(err) : resolve(res))
      })
    }
  }

  getAppJson () {
    /**
     *  合并所有 .json 的代码到 app.json
     */
    let code = Object.assign({}, this.appJsonCode)

    this.miniEntrys.forEach((entry) => {
      code.pages = code.pages.concat(code[entry].pages)
      code.subPackages = code.subPackages.concat(code[entry].subPackages)

      Object.assign(code.preloadRule, code[entry].preloadRule)
      Object.assign(code.usingComponents, code[entry].usingComponents)
      delete code[entry]
    })

    let subPackages = code.subPackages || []
    let copy = {}
    subPackages.forEach(pack => {
      if (copy[pack.root]) copy[pack.root].pages = copy[pack.root].pages.concat(pack.pages)
      else copy[pack.root] = pack
    })

    subPackages = code.subPackages = []

    Object.keys(copy).forEach(root => {
      let pack = copy[root]
      pack.pages = [...new Set(pack.pages)]
      subPackages.push(pack)
    })

    code.pages = [...new Set(code.pages)]
    Object.keys(code).forEach(() => {
      if (!code.key) delete code.key
    })

    return code
  }

  getExtJson () {
    if (!existsSync(this.options.extfile)) {
      console.warn(`${this.options.extfile} 文件找不到`)
      return new ConcatSource(JSON.stringify({}, null, 2))
    }

    let ext = require(this.options.extfile)
    return new ConcatSource(JSON.stringify(ext, null, 2))
  }

  setAppJson (config, resourcePath) {
    const {
      pages = [],
      subPackages = [],
      preloadRule = {},
      usingComponents = {},
      tabBar,
      window,
      networkTimeout,
      debug,
      functionalPages,
      plugins = {}
    } = config

    let appJson = this.appJsonCode[resourcePath] = {}

    /**
     * 保存 app.json 中的内容
     */
    appJson.pages = pages
    appJson.subPackages = subPackages
    appJson.preloadRule = preloadRule
    appJson.usingComponents = usingComponents
    this.appJsonCode.tabBar = this.appJsonCode.tabBar || tabBar
    /**
     * 插件
     */
    Object.keys(plugins).forEach((key) => {
      if (this.appJsonCode.plugins[key]) {
        if (plugins.version !== plugins[key].version) {
          console.log(`插件 ${key} 在 ${resourcePath} 中使用了和其他入口不同的版本`.yellow)
        }
        return
      }
      this.appJsonCode.plugins[key] = plugins[key]
    })

    /**
     * 其他配置使用最前面的配置
     */
    this.appJsonCode.window = this.appJsonCode.window || window
    this.appJsonCode.networkTimeout = this.appJsonCode.networkTimeout || networkTimeout
    this.appJsonCode.debug = this.appJsonCode.debug || debug
    this.appJsonCode.functionalPages = this.appJsonCode.functionalPages || functionalPages
  }

  getAppWxss (compilation) {
    let ext = '.wxss'
    let entryNames = [...new Set(this.entryNames)]
    let wxssCode = ''

    if (this.options.target === 'ali') {
      ext = '.acss'
      wxssCode += `
        /* polyfill */
        ${readFileSync(join(__dirname, './ali/lib/base.acss'), 'utf8')}
      `
    }

    entryNames.forEach((name) => {
      let code = compilation.assets[name + ext]
      if (code) {
        wxssCode += `/************ ${name + ext} *************/\n`
        wxssCode += code.source().toString()
      }
    })
    return new RawSource(wxssCode)
  }

  getIgnoreEntrys () {
    /**
     * 多个入口，所有文件对应的原始文件将被丢弃
     */
    let entryNames = [...new Set(this.entryNames)]

    entryNames = entryNames.map((name) => {
      if (name === 'app') return []
      return ['.json', '.wxss', '.js'].map(ext => name + ext)
    })

    entryNames = flattenDeep(entryNames)

    /**
     * 静态资源的主文件
     */
    entryNames = entryNames.concat(
      this.chunkNames.map(chunkName => chunkName + '.js')
    )

    return entryNames
  }

  addEntrys (context, files) {
    let assetFiles = []
    let scriptFiles = files.filter(file => {
      if (this.filesSet.has(file)) return false
      if (!this.filesSet.has(file)) {
        this.filesSet.add(file)
        ;/\.wxml$/.test(file) && this.xmlDepsMap.set(file, { isRoot: true, deps: new Map() })
      }
      return /\.js$/.test(file) ? true : assetFiles.push(file) && false
    })
    this.addAssetsEntry(context, assetFiles)
    this.addScriptEntry(context, scriptFiles)
  }

  addListenFiles (files) {
    /**
     * 添加所有已经监听的文件
     */
    files.forEach((file) => {
      if (!this.filesSet.has(file)) this.filesSet.add(file)
    })
  }

  addAssetsEntry (context, entrys) {
    let chunkName = mainChunkNameTemplate + mainChunkNameIndex
    this.chunkNames.push(chunkName)
    new MultiEntryPlugin(context, entrys, chunkName).apply(this.compiler)

    // 自动生成
    mainChunkNameIndex++
  }

  addScriptEntry (context, entrys) {
    for (const entry of entrys) {
      let fileName = relative(context, entry).replace(extname(entry), '')
      new SingleEntryPlugin(context, entry, fileName).apply(this.compiler)
    }
  }

  async loadEntrys (entry) {
    let index = 0

    this.entryNames = []

    let promiseSet = new Set()

    for (const item of entry) {
      this.fileTree.addEntry(item)

      const entryPath = item

      const itemContext = dirname(entryPath)
      const fileName = basename(entryPath, '.json')

      this.entryNames.push(fileName)

      /**
       * 主入口
       */
      if (index === 0) {
        this.mainEntry = item
        this.mainContext = itemContext
        this.mainName = fileName
        index++
      }

      /**
       * 获取配置信息，并设置
       */
      const config = require(item)
      this.setAppJson(config, item)

      /**
       * 添加页面
       */
      let pageFiles = this.getPagesEntry(config, itemContext)

      let componentSet = new Set()

      pageFiles.push(entryPath)

      promiseSet.add(
        this.loadComponentsFiles(pageFiles, componentSet)
          .then(() => {
            let files = flattenDeep(Array.from(componentSet))
            this.addEntrys(itemContext, files)
          })
      )

      this.addEntrys(itemContext, pageFiles)

      /**
       * 入口文件只打包对应的 wxss 文件
       */
      let entryFiles = getFiles(itemContext, fileName, ['.wxss'])

      this.fileTree.setFile(entryFiles)

      this.addEntrys(itemContext, entryFiles)
    }

    let tabBar = this.appJsonCode.tabBar
    let extfile = this.options.extfile

    let entrys = [
      getFiles(this.mainContext, 'project.config', ['.json']), // project.config.json
      extfile === true ? getFiles(this.mainContext, 'ext', ['.json']) : [], // ext.json 只有 extfile 为 true 的时候才加载主包的 ext.json
      getFiles(this.mainContext, this.mainName, ['.js']) // 打包主入口对应的 js 文件
    ]

    // tabBar icons
    entrys.concat((tabBar && tabBar.list && this.getTabBarIcons(this.mainContext, tabBar.list)) || [])

    this.addEntrys(this.mainContext, flattenDeep(entrys))
    return await Promise.all(Array.from(promiseSet))
  }

  async loadComponentsFiles (pageFiles, componentSet) {
    let jsons = pageFiles.filter((file) => /\.json/.test(file))

    for (const json of jsons) {
      let files = await resolveFilesForPlugin(this.resolver, json, this.componentSet)
      files = flattenDeep(files)
      componentSet.add(files)
      await this.loadComponentsFiles(flattenDeep(files), componentSet)
    }
  }
  /**
   * 根据 app.json 配置获取页面文件路径
   * @param {*} entry
   */
  getPagesEntry (config, context) {
    const pages = this.getNewPages(config, context)
    const files = pages.map((page) => {
      const files = this.getPageFiles(page)

      this.fileTree.addPage(page, files)

      return files
    })

    return flattenDeep(files)
  }

  getPageFiles (page) {
    let files = getFiles(page)
    if (files.length < 2) {
      console.log('⚠️ ', `页面 ${page} 目录必要文件不全`.yellow, '\n')
      return []
    }

    // 只有必要文件齐全的文件才会添加到集合
    files.length >= 2 && this.pagesSet.add(page)

    return files
  }

  getNewPages ({ pages = [], subPackages = [] }, context) {
    const _newPages = []
    const isNewPage = (page) => {
      if (!this.pagesSet.has(page)) {
        return true
      }
      return false
    }

    subPackages.forEach(({ root, pages }) => {
      let _pages = []

      pages.map((page) => {
        _pages.push(join(root, page))
        page = join(context, root, page)
        isNewPage(page) && _newPages.push(page)
      })

      this.subpackageMap.set(root, _pages)
    })

    pages.forEach((page) => {
      page = join(context, page)
      isNewPage(page) && _newPages.push(page)
    })

    return _newPages
  }

  /**
   * 获取 icon 路径
   * @param {*} context
   * @param {*} tabs
   */
  getTabBarIcons (context, tabs) {
    let files = []
    for (const tab of tabs) {
      let file = join(context, tab.iconPath)
      if (existsSync(file)) files.push(file)

      file = join(context, tab.selectedIconPath)

      if (existsSync(file)) files.push(file)
    }

    return files
  }

  moduleOnlyUsedBySubpackages (module) {
    if (!/\.js$/.test(module.resource) || module.isEntryModule()) return false
    if (!module._usedModules) throw new Error('非插件提供的 module，不能调用这个方法')

    let { subPackages } = this.getAppJson()
    let subRoots = subPackages.map(({ root }) => root) || []
    let subReg = new RegExp(subRoots.join('|'))
    let usedFiles = Array.from(module._usedModules)

    return !usedFiles.some(moduleName => !subReg.test(moduleName))
  }

  moduleUsedBySubpackage (module, root) {
    if (!/\.js$/.test(module.resource) || module.isEntryModule()) return false
    if (!module._usedModules) throw new Error('非插件提供的 module，不能调用这个方法')

    let reg = new RegExp(root)

    let usedFiles = Array.from(module._usedModules)

    return usedFiles.some(moduleName => reg.test(moduleName))
  }

  moduleOnlyUsedBySubPackage (module, root) {
    if (!/\.js$/.test(module.resource) || module.isEntryModule()) return false

    let usedFiles = module._usedModules

    if (!usedFiles) return false

    let reg = new RegExp(`^${root}`)

    return !Array.from(usedFiles).some(moduleName => !reg.test(moduleName))
  }

  /**
   * 判断所给的路径在不在自定义组件内
   * @param {String} path 任意路径
   */
  pathInSubpackage (path) {
    let { subPackages } = this.getAppJson()

    for (const { root } of subPackages) {
      let match = path.match(root)

      if (match !== null && match.index === 0) {
        return true
      }
    }

    return false
  }

  /**
   * 判断所给的路径集合是不是在同一个包内
   * @param {Array} paths 路径列表
   */
  pathsInSamePackage (paths) {
    // 取第一个路径，获取子包 root，然后和其他路径对比
    let firstPath = paths[0]
    let root = this.getPathRoot(firstPath)

    // 路径不在子包内
    if (!root) {
      return ''
    }

    let reg = new RegExp(`^${root}`)
    for (const path of paths) {
      if (!reg.test(path)) return ''
    }

    return root
  }

  /**
   * 判断列表内数据是不是在同一个目录下
   * @param {*} paths
   */
  pathsInSameFolder (paths) {
    let firstPath = paths[0]
    let folder = firstPath.split('/')[0]
    let reg = new RegExp(`^${folder}`)

    for (const path of paths) {
      if (!reg.test(path)) return ''
    }

    return folder
  }

  /**
   * 获取路径所在的 package root
   * @param {String} path
   */
  getPathRoot (path) {
    let { subPackages } = this.getAppJson()

    for (const { root } of subPackages) {
      let match = path.match(root)

      if (match !== null && match.index === 0) {
        return root
      }
    }

    return ''
  }

  /**
   *
   * @param {*} root
   * @param {*} files
   */
  otherPackageFiles (root, files) {
    return files.filter(file => file.indexOf(root) === -1)
  }

  /**
   * loader 中传递被修改的 app.json
   */
  appJsonChange (config, appPath) {
    this.setAppJson(config, appPath)

    let newPages = this.getNewPages(config, dirname(appPath))
    let pageFiles = newPages.map(this.getPageFiles.bind(this))

    pageFiles = flattenDeep(pageFiles).filter(file => !this.filesSet.has(file))
    this._appending = this._appending.concat(pageFiles)
  }

  addWxmlDeps (resourcePath, deps) {
    if (this.xmlDepsMap.has(resourcePath)) {
      let target = this.xmlDepsMap.get(resourcePath)
      let children = target.deps

      deps.forEach(path => {
        if (this.xmlDepsMap.has(path) && target.isLoaded) {
          children.set(path, this.xmlDepsMap.get(path))
          return
        }

        let pathQuery = {
          deps: new Map()
        }

        if (this.xmlDepsMap.has(path)) {
          pathQuery = this.xmlDepsMap.get(path)
        }

        children.set(path, pathQuery)
        this.xmlDepsMap.set(path, pathQuery)
      })

      target.isLoaded = true

      return
    }

    throw new Error('unbeliveable')
  }
}