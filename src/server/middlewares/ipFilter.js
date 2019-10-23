/**
 * Module dependencies.
 */
const micromatch = require('micromatch')

/**
 * Return ipFilter middleware:
 *
 * @param {string[]} filter - The filter
 * @return {Function} - The middleware function
 * @api public
 */
const ipFilter = (filter) => async (ctx, next) => {
  const { ip } = ctx.request
  if (micromatch.isMatch(ip, filter)) {
    await next()
  } else {
    logger.error(new Error(`${ip} is not authorized`))
    ctx.throw(401, 'access denied ', `${ip} is not authorized`)
  }
}

module.exports = ipFilter
