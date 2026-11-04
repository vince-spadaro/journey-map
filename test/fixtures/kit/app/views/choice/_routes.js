// A start page whose two links go to the same sign in page with different
// answers in the address, and a route after sign in that branches on them
module.exports = function (router) {
  var base = '/choice'

  router.post(base + '/sign-in', function (req, res) {
    if (req.session.data.startChoice === 'decline') {
      res.redirect(base + '/decline')
    } else {
      res.redirect(base + '/consent')
    }
  })
}
