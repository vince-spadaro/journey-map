// A journey whose answer goes back to a start address that redirects again,
// and whose index page lists each page's states and errors as data
module.exports = function (router) {
  var base = '/listed'

  router.get(base + '/start', function (req, res) {
    res.redirect(base + '/choose')
  })

  router.post(base + '/choose', function (req, res) {
    res.redirect(base + '/confirm')
  })

  router.post(base + '/confirm', function (req, res) {
    res.redirect(base + (req.body.confirm === 'false' ? '/start' : '/check'))
  })
}
