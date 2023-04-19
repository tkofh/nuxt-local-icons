import {
  defineNuxtModule,
  useLogger,
  createResolver,
  addTemplate,
  updateTemplates,
  addComponent,
} from '@nuxt/kit'
import { readFile } from 'node:fs/promises'
import glob from 'fast-glob'
import { extname } from 'pathe'
import { withTrailingSlash, joinURL } from 'ufo'
import { compile } from '@vue/compiler-dom'
import { outdent } from 'outdent'

// Module options TypeScript interface definition
export interface ModuleOptions {
  location: string
  componentName: string
  typeName: string
  warnMissingIcon: boolean
}

interface ProcessedIcon {
  key: string
  imports: string
  renderFunction: string
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'local-icons',
    configKey: 'icons',
  },
  // Default configuration options of the Nuxt module
  defaults: {
    location: '~/assets/icons',
    componentName: 'AppIcon',
    typeName: 'Icon',
    warnMissingIcon: true,
  },
  async setup(options, nuxt) {
    const logger = useLogger('icons')
    const rootResolver = createResolver(nuxt.options.rootDir)
    const buildResolver = createResolver(nuxt.options.buildDir)

    let iconSourceDirectory: string = ''

    try {
      iconSourceDirectory = withTrailingSlash(
        await rootResolver.resolvePath(options.location)
      )
    } catch (e) {
      logger.warn('Cannot load icons directory, disabling icon module')
    }

    if (iconSourceDirectory !== '') {
      const IMPORTS_RE = /import[^\n]+/

      nuxt.options.alias['#icons'] = addTemplate({
        write: true,
        filename: buildResolver.resolve('icons.ts'),
        getContents: async () => {
          const iconPaths = await glob(
            joinURL(iconSourceDirectory, '/**/*.svg')
          )

          const results = (
            await Promise.allSettled(
              iconPaths.map((path) =>
                readFile(path, { encoding: 'utf-8' }).then((source) => {
                  const key = path
                    .replace(iconSourceDirectory, '')
                    .replace(extname(path), '')

                  const { code } = compile(source, {
                    mode: 'module',
                    isTS: true,
                  })

                  const imports = IMPORTS_RE.exec(code)![0]

                  const renderFunction = code
                    .replace(IMPORTS_RE, '')
                    .replace('export function render', `function`)
                    .trim()

                  return {
                    key,
                    imports,
                    renderFunction,
                  }
                })
              )
            )
          ).reduce<ProcessedIcon[]>((results, result, index) => {
            if (result.status === 'fulfilled') {
              results.push(result.value)
            } else {
              logger.warn(`Unable to process ${iconPaths[index]}`)
            }

            return results
          }, [])

          return outdent`
            ${results[0].imports}
            import { defineComponent, h } from 'vue'

            const ${options.componentName}_lookup = {
            ${results
              .map((result) => `  '${result.key}': ${result.renderFunction},\n`)
              .join('\n')}
            } as const

            export type ${options.typeName} = keyof typeof ${
            options.componentName
          }_lookup

            export const ${options.componentName} = defineComponent({
              name: '${options.componentName}',
              props: {
                icon: {
                  type: String as { (): ${options.typeName} },
                  required: true,
                }
              },
              setup: (props) => () => {
                const rf = ${options.componentName}_lookup[props.icon]
                ${
                  options.warnMissingIcon && nuxt.options.dev
                    ? `if(!rf) { console.warn(\`[${options.componentName}]: Missing Icon '$\{props.icon}'\`) }`
                    : ''
                }
                return rf ? h(rf) : h('svg')
              }
            })
          `
        },
      }).dst

      await addComponent({
        name: options.componentName,
        export: options.componentName,
        filePath: '#icons',
      })

      if (nuxt.options.dev) {
        const watchPrefix = iconSourceDirectory.replace(
          withTrailingSlash(nuxt.options.rootDir),
          ''
        )
        nuxt.hook('builder:watch', (_, path) => {
          if (path.startsWith(watchPrefix)) {
            updateTemplates({
              filter: (template) =>
                template.dst === nuxt.options.alias['#icons'],
            })
          }
        })
      }
    }
  },
})
