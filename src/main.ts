import { bootstrapApplication } from '@angular/platform-browser';
import { provideHighcharts } from 'highcharts-angular';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, {
  providers: [
    provideHighcharts({
      instance: () => import('highcharts/esm/highcharts').then(module => module.default),
      modules: () => [import('highcharts/esm/modules/accessibility')]
    })
  ]
}).catch(error => console.error(error));
