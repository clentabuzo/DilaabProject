import React, { useRef } from 'react'
import products, { CATEGORY_ORDER } from './products.js'

function Showcase() {
  // Store references for each category's scroll container
  const scrollRefs = useRef({})

  const scroll = (category, direction) => {
    const container = scrollRefs.current[category]
    if (container) {
      const scrollAmount = direction === 'left' ? -340 : 340
      container.scrollBy({ left: scrollAmount, behavior: 'smooth' })
    }
  }

  return (
    <section className="showcase" id="showcase">
      <div className="section-head">
        <h2>WHAT WE'VE MADE</h2>
        <p>
          Every piece here was designed by a member and handed out to the club
          except paddles.
        </p>
      </div>

      <div className="categories">
        {CATEGORY_ORDER.map((category) => {
          const categoryProducts = products.filter(
            (item) => item.tag === category
          )

          return (
            <div className="category-group" key={category}>
              <div className="category-header-wrap">
                <h3 className="category-heading">{category}</h3>
                
                {/* Arrow Navigation Controls */}
              </div>

              {/* Scrollable Gallery Row */}
              <div
                className="gallery"
                ref={(el) => (scrollRefs.current[category] = el)}
              >
                {categoryProducts.map((product) => (
                  <div className="card" key={product.id}>
                    <div
                      className={`card-image ${
                        !product.image ? 'is-placeholder' : ''
                      }`}
                    >
                      {product.image ? (
                        <img src={product.image} alt={product.name} />
                      ) : (
                        <span>Photo coming soon</span>
                      )}
                    </div>
                    <span className="tag">{product.tag}</span>
                    <h3>{product.name}</h3>
                    <p>{product.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default Showcase