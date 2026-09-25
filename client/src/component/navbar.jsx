import logo from '../assets/dlogo.png'

function Navbar() {
  return (
    <nav className="navbar">
      <div className="nav-wrap">
        <a href="#top" className="brand">
          <img src={logo} alt="Dilaab Pickleball" className="brand-logo" />
          <span>DILAAB</span>
        </a>
        <div className="nav-links">
          <a href="#showcase">Showcase</a>
          <a href="#about">About</a>
          <a href="#join">Join</a>
        </div>
      </div>
    </nav>
  )
}

export default Navbar
