const govukPrototypeKit = require('govuk-prototype-kit')
const router = govukPrototypeKit.requests.setupRouter()

// A different journey with its own `base`, to check names don't leak between scopes
function otherRoutes (router) {
  const base = '/other'
  router.post(base + '/start', (req, res) => res.redirect(base + '/end'))
}
otherRoutes(router)
