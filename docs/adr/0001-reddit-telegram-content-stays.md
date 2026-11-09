# Reddit and Telegram content stays in the library

Reddit posts and Telegram posts are stored and shown. Their text is not sent to a hosted model and is not used to train one. The owner chose this on 2026-11-09 over pausing those sources until the open legal questions were signed off.

Reddit's Data API Terms (§2.4, revised 2026-07-20) allow copying and displaying User Content to run the app, and they forbid using that content to train a model without the rightsholders' permission. §3.1 still requires Reddit's own agreement for a commercial use. That agreement is not in hand. The feeds stay on anyway. Telegram stays on the same rule it already had: content in, no Telegram text to a hosted model (API Terms §1.5).

Switching `redditEnabled` off pauses new reads and deletes nothing. Corroborated auto-alias is not shipped: a bad alias would feed face enrolment, and two shapes from the same page are not independent evidence.
