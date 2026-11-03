import {createElement,Clock,Search,Star,LayoutGrid,List,File,Ellipsis,Plus,PanelLeft} from 'lucide';
const nodes={clock:Clock,search:Search,star:Star,grid:LayoutGrid,list:List,file:File,more:Ellipsis,plus:Plus,panel:PanelLeft};
export const icon=name=>createElement(nodes[name],{width:18,height:18,'stroke-width':1.6,'aria-hidden':'true'}).outerHTML;
