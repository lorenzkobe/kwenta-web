import { LandingFeatures } from './LandingFeatures'
import { LandingFinalCta } from './LandingFinalCta'
import { LandingFooter } from './LandingFooter'
import { LandingHeader } from './LandingHeader'
import { LandingHero } from './LandingHero'
import { LandingHowItWorks } from './LandingHowItWorks'
import { LandingOffline } from './LandingOffline'
import { LandingProductDemo } from './LandingProductDemo'
import { LandingTrustStrip } from './LandingTrustStrip'
import { LandingUseCases } from './LandingUseCases'

export function LandingPage() {
  return (
    <div className="min-h-screen text-stone-800 antialiased">
      <LandingHeader />
      <main>
        <LandingHero />
        <LandingProductDemo />
        <LandingTrustStrip />
        <LandingFeatures />
        <LandingHowItWorks />
        <LandingOffline />
        <LandingUseCases />
        <LandingFinalCta />
      </main>
      <LandingFooter />
    </div>
  )
}
