import logo from '../assets/dlogo.png'
import '../css/navbar.css'

function Navbar({ view, onNavigate }) {
  const goHome = (e) => {
    if (view !== 'home') {
      e.preventDefault()
      onNavigate('home')
    }
  }

  return (
    <nav className="navbar">
      <div className="nav-wrap">
        <a href="#top" className="brand" onClick={goHome}>
          <img src={logo} alt="Dilaab Pickleball" className="brand-logo" />
          <span>DILAAB</span>
        </a>

        {view === 'home' ? (
          <div className="nav-links">
            <a href="#showcase">Showcase</a>
            <a href="#about">About</a>
            <a href="#join">Join</a>
            <button
  className="nav-tab-btn nav-tab-btn--play"
  onClick={() => onNavigate('queue')}
>
  <span className="nav-live-dot" aria-hidden="true" />
  Open Play
</button>
          </div>
        ) : (
          <div className="nav-links">
            <a href="#leaderboard">Leaderboard</a>
           <button
  className="nav-tab-btn nav-tab-btn--back"
  onClick={() => onNavigate('home')}
>
  <span className="nav-arrow" aria-hidden="true">←</span>
  Back to site
</button>
          </div>
        )}
      </div>
    </nav>
  )
}

export default Navbar