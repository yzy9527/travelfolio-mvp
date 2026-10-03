import 'reflect-metadata';
import {Module,Controller,Get,Post,Put,Delete,Patch,Body,Param,Query,Req,Res,Inject,INestApplication} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import type {Request,Response,NextFunction} from 'express';
import {AppService,Session} from './service';
import {Config} from './config';
import {Database} from './db';
import {ApiError,SafeErrorFilter,reject} from './errors';
import {sameSecret} from './passwords';
import {rateLimit} from './rate-limit';
import {exportHtml} from './export';
interface AuthRequest extends Request {auth:Session;}
@Controller()
class ApiController {
  constructor(@Inject(AppService) private service:AppService){}
  @Get('health') async health(){await this.service.db.query('SELECT 1');return {status:'ok'};}
  private sessionCookie(res:Response,value:string){res.cookie('tf_session',value,{httpOnly:true,secure:this.service.config.cookieSecure,sameSite:'lax',path:'/api',maxAge:7*86400000});}
  @Post('auth/login') async login(@Body() body:unknown,@Req() req:Request,@Res({passthrough:true}) res:Response){const result=await this.service.login(body,req.socket.remoteAddress||'unknown');this.sessionCookie(res,result.sessionToken);return {user:result.user,csrfToken:result.csrfToken};}
  @Post('auth/register') async register(@Body() body:unknown,@Req() req:Request,@Res({passthrough:true}) res:Response){const result=await this.service.register(body,req.socket.remoteAddress||'unknown');this.sessionCookie(res,result.sessionToken);return {user:result.user,csrfToken:result.csrfToken};}
  @Get('auth/me') me(@Req() req:AuthRequest){return {user:req.auth.user,csrfToken:req.auth.csrfToken};}
  @Post('auth/logout') async logout(@Req() req:AuthRequest,@Res({passthrough:true}) res:Response){const result=await this.service.logout(req.auth);res.clearCookie('tf_session',{httpOnly:true,secure:this.service.config.cookieSecure,sameSite:'lax',path:'/api'});return result;}
  @Get('settings') settings(@Req() req:AuthRequest){return this.service.getSettings(req.auth.user.id);}
  @Put('settings') saveSettings(@Req() req:AuthRequest,@Body() body:unknown){return this.service.saveSettings(req.auth.user.id,body);}
  @Delete('settings/key') deleteKey(@Req() req:AuthRequest){return this.service.deleteKey(req.auth.user.id);}
  @Get('trips') trips(@Req() req:AuthRequest){return this.service.listTrips(req.auth.user.id);}
  @Post('trips') createTrip(@Req() req:AuthRequest,@Body() body:unknown){return this.service.createTrip(req.auth.user.id,body);}
  @Get('trips/:id') trip(@Req() req:AuthRequest,@Param('id') id:string){return this.service.getTrip(req.auth.user.id,id);}
  @Get('trips/:id/versions/:versionId') version(@Req() req:AuthRequest,@Param('id') id:string,@Param('versionId') v:string){return this.service.getVersion(req.auth.user.id,id,v);}
  @Post('trips/:id/jobs') job(@Req() req:AuthRequest,@Param('id') id:string,@Body() body:unknown){return this.service.createJob(req.auth.user.id,id,body);}
  @Get('jobs/:id') getJob(@Req() req:AuthRequest,@Param('id') id:string){return this.service.getJob(req.auth.user.id,id);}
  @Post('jobs/:id/cancel') cancel(@Req() req:AuthRequest,@Param('id') id:string){return this.service.cancelJob(req.auth.user.id,id);}
  @Post('jobs/:id/approve-outline') approveOutline(@Req() req:AuthRequest,@Param('id') id:string,@Body() body:unknown){return this.service.approveOutline(req.auth.user.id,id,body);}
  @Post('jobs/:id/resume') resume(@Req() req:AuthRequest,@Param('id') id:string,@Body() body:unknown){return this.service.resumeJob(req.auth.user.id,id,body);}
  @Post('trips/:id/versions/:versionId/review') review(@Req() req:AuthRequest,@Param('id') id:string,@Param('versionId') v:string,@Body() body:unknown){return this.service.reviewVersion(req.auth.user.id,id,v,body);}
  @Post('trips/:id/versions/:versionId/review-assets') reviewAssets(@Req() req:AuthRequest,@Param('id') id:string,@Param('versionId') v:string,@Body() body:unknown){return this.service.reviewAssets(req.auth.user.id,id,v,body);}
  @Get('trips/:id/versions/:versionId/artifact') async artifact(@Req() req:AuthRequest,@Param('id') id:string,@Param('versionId') v:string,@Res() res:Response){
    const data=await this.service.artifact(req.auth.user.id,id,v);
    // Never serve executable generated HTML as a same-origin top-level document.
    // The UI fetches these bytes into an opaque sandbox. Trusted script hashes are
    // inside the generated document's stricter CSP; this response is download-only.
    res.setHeader('Content-Disposition',`attachment; filename="travelfolio-handbook-v${data.number}.html"`);
    res.setHeader('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Artifact-Sha256',data.hash);
    res.type('html').send(data.html);
  }
  @Post('trips/:id/versions/:versionId/adopt') adopt(@Req() req:AuthRequest,@Param('id') id:string,@Param('versionId') v:string,@Body() body:unknown){return this.service.adoptVersion(req.auth.user.id,id,v,body);}
  @Post('trips/:id/versions/:versionId/discard') discard(@Req() req:AuthRequest,@Param('id') id:string,@Param('versionId') v:string){return this.service.discardVersion(req.auth.user.id,id,v);}
  @Get('trips/:id/export') async export(@Req() req:AuthRequest,@Param('id') id:string,@Query('format') format:string|undefined,@Query('versionId') versionId:string|undefined,@Res() res:Response){
    if(format&&format!=='html'&&format!=='json')reject(400,'INVALID_FORMAT','支持 HTML 或 JSON 导出');
    const data=await this.service.exportVersion(req.auth.user.id,id,versionId);const html=format==='html';
    res.setHeader('Content-Disposition',`attachment; filename="travelfolio-v${data.version}.${html?'html':'json'}"`);res.setHeader('Cache-Control','no-store');
    if(html){res.setHeader('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");}
    const output=html?(data.guide?(await this.service.artifact(req.auth.user.id,id,data.versionId)).html:exportHtml(data)):JSON.stringify(data,null,2);
    res.type(html?'html':'json').send(output);
  }
  @Get('admin/users') users(@Req() req:AuthRequest){return this.service.listUsers(req.auth.user);}
  @Patch('admin/users/:id') userStatus(@Req() req:AuthRequest,@Param('id') id:string,@Body() body:unknown){return this.service.setUserStatus(req.auth.user,id,body);}
  @Post('admin/invites') invite(@Req() req:AuthRequest){return this.service.createInvite(req.auth.user);}
  @Get('admin/overview') overview(@Req() req:AuthRequest){return this.service.overview(req.auth.user);}
}
@Module({}) class AppModule{}
export async function createApp(db:Database,config:Config):Promise<INestApplication>{
  const service=new AppService(db,config);
  const app=await NestFactory.create({module:AppModule,controllers:[ApiController],providers:[{provide:AppService,useValue:service}]},{logger:false});
  app.setGlobalPrefix('api');app.useGlobalFilters(new SafeErrorFilter());
  const express=app.getHttpAdapter().getInstance();express.disable('x-powered-by');express.set('trust proxy',false);
  app.use(helmet({strictTransportSecurity:false}));app.use(cookieParser());
  app.use(async(req:AuthRequest,res:Response,next:NextFunction)=>{
    res.setHeader('Cache-Control','no-store');
    try{
      if(req.method==='OPTIONS')reject(405,'METHOD_NOT_ALLOWED','不支持跨站请求');
      const write=!['GET','HEAD'].includes(req.method);
      if(write){
        if(req.get('origin')!==config.appOrigin)reject(403,'ORIGIN_REJECTED','请求来源不匹配，请通过配置的网站地址访问');
        if(!req.is('application/json'))reject(415,'JSON_REQUIRED','请求需要 JSON 格式');
      }
      const publicRoute=(req.path==='/api/health'&&['GET','HEAD'].includes(req.method))||(['/api/auth/login','/api/auth/register'].includes(req.path)&&req.method==='POST');
      if(!publicRoute){
        req.auth=await service.authenticate(req.cookies?.tf_session);
        await rateLimit(db,`requests:${req.auth.user.id}`,240,60);
        if(write&&!sameSecret(req.get('x-csrf-token')||'',req.auth.csrfToken))reject(403,'CSRF_REJECTED','页面凭证已过期，请刷新后重试');
      }
      next();
    }catch(error){const known=error instanceof ApiError;res.status(known?error.status:500).json({error:{code:known?error.code:'INTERNAL',message:known?error.message:'服务暂时不可用'}});}
  });
  await app.init();return app;
}
