# Reddit and Telegram content stays in the library

Reddit posts and Telegram posts are stored and shown. Their text is not sent to a hosted model and is not used to train one. The owner chose this on 2026-11-09 over pausing those sources until the open legal questions were signed off.

Reddit's Data API Terms (§2.4, revised 2026-07-20) allow copying and displaying User Content to run the app, and they forbid using that content to train a model without the rightsholders' permission. §3.1 still requires Reddit's own agreement for a commercial use. That agreement is not in hand. The feeds stay on anyway. Telegram stays on the same rule it already had: content in, no Telegram text to a hosted model (API Terms §1.5).

PRISM does not ask a visitor or a creator for consent before it stores or shows a public post. There is no consent form and no consent banner. The 18+ check stays. A removal request still hides that item.

Switching `redditEnabled` off pauses new reads and deletes nothing. Shipped 2026-11-10, narrower than the general auto-alias idea: a deep-pull result on a platform PRISM only links out (Instagram, Threads, TikTok, Snapchat, Twitch) becomes a LOW-signal handle alias when the handle itself names him — it never creates a feed, never fetches the page, and adds no media, so it cannot steer face enrolment; two shapes from one page still count as one witness, not two.
