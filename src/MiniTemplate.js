const { join } = require('path')
const utils = require('./utils')
const {
  ConcatSource,
  RawSource
} = require('webpack-sources')

module.exports = class MiniTemplate {
  constructor (plugin) {
    this.$plugin = plugin
    this.outPath = this.$plugin.outputPath
    this.requirePath = join(this.outPath, './webpack-require')
  }
  apply (compiler) {
    this.compiler = compiler

    compiler.hooks.compilation.tap('MiniTemplate', (compilation) => {
      this.compilation = compilation

      compilation.mainTemplate.hooks.render.tap('MiniTemplate', this.setRender.bind(this))
    })
  }

  getRequirePath (entry) {
    let entryPath = join(this.outPath, utils.getDistPath(entry))
    return utils.relative(entryPath, this.requirePath)
  }

  setRender (bootstrapSource, chunk, hash, moduleTemplate, dependencyTemplates) {
    try {
      const mainTemplate = this.compilation.mainTemplate
      const source = new ConcatSource()
      const modules = this.getDepModules(chunk)

      // 抽取的公用代码，不使用这个render处理
      if (!chunk.entryModule.resource) {
        return source
      }

      const globalRequire = 'require'

      /**
       * 计算出 webpack-require 相对改 chunk 的路径
       */
      source.add(`/******/ var webpackRequire = ${globalRequire}("./${this.getRequirePath(chunk.entryModule.resource)}");\n`)
      source.add(`/******/ webpackRequire(\n`)
      source.add(`"${chunk.entryModule.id}",\n`)
      modules.size && source.add('Object.assign(')

      for (const item of modules) {
        source.add(`${globalRequire}("./${item}").modules, `)
      }

      source.add(
        mainTemplate.hooks.modules.call(
          new RawSource(''),
          chunk,
          hash,
          moduleTemplate,
          dependencyTemplates
        )
      )
      modules.size && source.add(')')
      source.add(')')
      return source
    } catch (error) {
      console.log(error)
    }
  }

  getDepModules (chunk) {
    let groups = chunk.groupsIterable
    let modules = new Set()

    if (chunk.hasEntryModule()) {
      // 当前 chunk 最后被打包的位置
      let file = utils.getDistPath(`${chunk.name}.js`)

      for (const chunkGroup of groups) {
        for (const { name } of chunkGroup.chunks) {
          if (name !== chunk.name) {
            // 依赖 chunk 最后被打包的位置
            let depFile = utils.getDistPath(`${name}.js`)
            modules.add(utils.relative(file, depFile))
          }
        }
      }
    }

    return modules
  }
}
