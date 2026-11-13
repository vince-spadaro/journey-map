// The journey carries on in another journey folder: "#continues-in-<folder>"
// names the folder, for a redirect (which stays on the page in the prototype)
// as well as a link
module.exports = function (router) {
  var base = '/leave'

  router.post(base + '/resend', function (req, res) {
    if (req.session.data.resendTo === 'new') {
      res.redirect(base + '/resend#continues-in-create-request')
    } else {
      res.redirect(base + '/requests')
    }
  })
}
