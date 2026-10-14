module.exports = function (router) {
  const base = '/apply'

  router.post(base + '/name', function (req, res) {
    if (!req.session.data.name) {
      return res.render('apply/name', { errors: { name: 'Enter your name' } })
    }
    res.redirect(base + '/where-do-you-live')
  })

  router.post(base + '/where-do-you-live', function (req, res) {
    const answer = req.session.data['where-do-you-live']
    if (answer === 'england') {
      res.redirect(base + '/check-answers')
    } else if (answer === 'abroad') {
      res.redirect('/other/start')
    } else {
      res.redirect(base + '/ineligible')
    }
  })

  router.post(base + '/lookup-router', (req, res) => {
    const found = lookup(req.session.data.postcode)
    res.redirect(`${base}/${found ? 'choose-address' : 'no-address'}`)
  })

  router.post(base + '/check-answers', (req, res) => {
    res.redirect(base + '/done')
  })
}
