const fs = require('fs')
const path = require('path')

/**
 * node-llama-cpp's postinstall leaves a Windows junction under _hidden_xpack
 * that points at llama/xpack/... which does not exist. electron-builder calls
 * realpathSync on that junction and aborts the pack with ENOENT.
 */
module.exports = async function beforePack() {
  const junction = path.join(
    __dirname,
    '..',
    'node_modules',
    'node-llama-cpp',
    '_hidden_xpack',
    'xpacks',
    '@xpack-dev-tools',
    'cmake'
  )

  try {
    const stat = fs.lstatSync(junction)
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      fs.rmSync(junction, { recursive: false, force: true })
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      throw err
    }
  }
}
