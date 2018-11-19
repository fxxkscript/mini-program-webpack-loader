const {
  join,
  isAbsolute,
  dirname,
  basename
} = require('path')

const {
  existsSync
} = require('fs')

const EXTS = ['.js', '.json', '.wxml', '.wxss', '.wxs', '.scss', '.pcss', '.less']

exports.getDistPath = (compilerContext, entryContexts = [], resources = [], outPath) => {
  let sourceSet = new Set([compilerContext, ...resources])

  entryContexts.forEach(entry => sourceSet.add(dirname(entry)))

  sourceSet = Array.from(sourceSet)

  /**
   * webpack 以 config 所在目录的 src 为打包入口
   * 所以可以根据该目录追溯源文件地址
   */
  return (path) => {
    let fullPath = compilerContext
    let npmReg = /node_modules/g

    if (path === outPath) return path

    path = path.replace(/(\.\.\/)?/g, ($1) => $1 ? '_/' : '')

    if (isAbsolute(path)) {
      fullPath = path
    } else {
      // 相对路径：webpack 最好生成的路径，打包入口外的文件都以 '_' 表示上级目录
      let pDirReg = /_\//g

      while (pDirReg.test(path)) {
        path = path.substr(pDirReg.lastIndex)
        pDirReg.lastIndex = 0
        fullPath = join(fullPath, '../')
      }

      if (fullPath !== compilerContext) {
        fullPath = join(fullPath, path)
      }
    }

    // 根据 entry 中定义的 json 文件目录获取打包后所在目录，如果不能获取就返回原路径
    let contextReg = new RegExp(sourceSet.join('|'), 'g')
    if (fullPath !== compilerContext && contextReg.exec(fullPath)) {
      path = fullPath.substr(contextReg.lastIndex + 1)
      console.assert(!npmReg.test(path), `文件${path}路径错误：不应该还包含 node_modules`)
    }

    /**
     * 如果有 node_modules 字符串，则去模块名称
     * 如果 app.json 在 node_modules 中，那 path 不应该包含 node_modules
     */

    if (npmReg.test(path)) {
      path = path.substr(npmReg.lastIndex + 1)
    }

    return path
  }
}

/**
 * 获取文件路径
 * @param {*} base
 * @param {*} path
 * @param {*} exts
 */
exports.getFiles = (base, path = '', exts) => {
  let files = []

  path = join(base, path)

  for (const ext of (exts || EXTS)) {
    let file = path + ext
    if (existsSync(file)) files.push(file)
  }

  return files
}

/**
 * 扁平数组
 * @param {Array} arr 输入数组
 */
exports.flattenDeep = (arr) => {
  while (arr.some(item => Array.isArray(item))) {
    arr = [].concat(...arr)
  }
  return arr
}

exports.setMapValue = (origin, protertyName, value) => {
  let proterty = origin[protertyName]
  if (!proterty) {
    let proterty = origin[protertyName] = new Set()
    proterty.add(value)
  } else {
    proterty.add(value)
  }
}

/**
 * 标准化入口
 * @param {any} entry webpack config entry
 * 1. entry: 'path/entry.json' => ['path/entry.json']
 * 2. entry: [ 'path/entry1.json', 'path/entry2.json', 'path/index.js' ] => [ 'path/entry1.json', 'path/entry2.json' ]
 * 3. entry: { app1: 'path/entry1.json', app2: 'path/entry2.json', index: 'path/index.js' } => [ 'path/entry1.json', 'path/entry2.json' ]
 * @param {Array} chunkNames 被忽略的 chunk
 */
exports.formatEntry = (context = process.cwd(), entry = [], chunkNames = []) => {
  let miniEntrys = []

  let getEntry = entry => {
    entry = isAbsolute(entry) ? entry : join(context, entry)
    if (!existsSync(entry)) throw new Error('找不到文件：', entry)
  }

  if (typeof entry === 'object' && entry !== null) {
    Object.keys(entry).forEach((key) => {
      if (/\.json/.test(entry[key])) {
        chunkNames.push(key)
        miniEntrys.push(getEntry(entry[key]))
      }
    })
  }

  if (Array.isArray(entry)) {
    entry.forEach(item => {
      if (/\.json/.test(item)) {
        miniEntrys.push(getEntry(item))
      }
    })
  }

  if (typeof entry === 'string' && /\.json/.test(entry)) miniEntrys = [entry]

  if (!miniEntrys.length) throw new Error('找不到一个有效的入口文件')

  return miniEntrys
}