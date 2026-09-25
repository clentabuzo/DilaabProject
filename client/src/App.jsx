import './App.css'
import Navbar from './component/navbar.jsx'
import Showcase from './component/showcase.jsx'

function App() {
  return (
    <>
      <Navbar />

      <main>
        <section className="hero" id="top">
          <div className="hero-wrap">
            <h1>
              GEAR WE MADE
              <br />
              FOR EACH OTHER
            </h1>

            <p className="tagline">
              Fiery Soul. Competitive Spirit.
            </p>

            <p className="lede">
              You're invited to join the DILAAB Pickleball Club Messenger —
              the official space for our growing pickleball community.
            </p>

            <div className="hero-actions">
              <a
                className="btn-primary"
                href="https://m.me/cm/gKnvjPvyxEPrlslp/?send_source=cm:copy_invite_link"
                target="_blank"
                rel="noreferrer"
              >
                Join the Messenger group
              </a>

              <a className="btn-ghost" href="#showcase">
                See the gear
              </a>
            </div>
          </div>
        </section>

        <Showcase />

        <section className="about" id="about">
          <div className="about-grid">
            <div>
              <h2>Fiery soul. Competitive spirit.</h2>

              <p>
                DILAAB started as a handful of players chasing the same open
                court on weekends. Now we're a full club — leagues, open
                play, and a Messenger group where the next game gets planned.
              </p>
            </div>

            <ul className="roster">
              <li>
                <span>Members</span>
                <span>Growing weekly</span>
              </li>

              <li>
                <span>Play nights</span>
                <span>Tues/Wed &amp; Friday</span>
              </li>

              <li>
                <span>Skill levels</span>
                <span>All welcome</span>
              </li>
            </ul>
          </div>
        </section>

        <section className="join" id="join">
          <div className="join-card">
            <h2>Ready to play?</h2>

            <p>
              Join the DILAAB Pickleball Club Messenger for court times, open
              play, and everything else happening this season.
            </p>

            <a
              className="btn-primary"
              href="https://www.facebook.com/share/14mYhBJcDst/"
              target="_blank"
              rel="noreferrer"
            >
              Join the Facebook Page
            </a>

            <br />
            <br />

            <a
              className="btn-primary"
              href="https://m.me/cm/gKnvjPvyxEPrlslp/?send_source=cm:copy_invite_link"
              target="_blank"
              rel="noreferrer"
            >
              Join the Messenger group
            </a>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <span>
          © {new Date().getFullYear()} Dilaab Pickleball Club
        </span>
      </footer>
    </>
  )
}

export default App