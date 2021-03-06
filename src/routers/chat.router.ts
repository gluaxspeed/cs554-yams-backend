import User, { IUser } from '../models/user.model';
import Chat, { IChat, IChatModel } from '../models/chat.model';
import { NextFunction, Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import Message, { IMessage } from '../models/message.model';
import multer from 'multer';
import AWS from 'aws-sdk';
import uuidv4 from 'uuid/v4';

AWS.config.region = 'us-east-2';
AWS.config.accessKeyId = process.env.AWS_KEY;
AWS.config.secretAccessKey = process.env.AWS_SECRET;

const upload = multer();
const bucket = new AWS.S3();

export default class ChatRouter {
   public router: Router;
   private BUCKET_NAME: string;

   constructor() {
      this.router = Router();
      this.routes();
   }

   private async authReq(
      req: Request,
      res: Response,
      next: NextFunction
   ): Promise<void> {
      try {
         req.get('Authorization');
         const auth = req.get('Authorization');
         if (!auth) throw 'Authorization Required.';
         const tkn: any = await jwt.verify(
            auth.split(' ')[1],
            process.env.JWT_SECRET
         );
         const chat = await Chat.findById(req.params.id, {
            users: { $elemMatch: { username: tkn.username } }
         });
         if (!chat) throw `Specified chat '${req.params.id}' was not found.`;
         if (chat.users.length === 0)
            throw `User '${tkn.username}' is not verified for chat '${
               req.params.id
            }'`;
         res.locals.username = tkn.username;
         next();
      } catch (err) {
         res.status(403).json({
            error: [{ msg: err }]
         });
      }
   }

   private async createChat(req: Request, res: Response): Promise<void> {
      const cname: string = req.body.chatname;
      const img: string = req.body.img;
      const usernames: Array<string> = req.body.usernames;
      let gc = false;

      req.checkBody('chatname', 'Chat name is required').notEmpty();
      req.checkBody('usernames', 'Must add users to group chat').notEmpty();
      const errors: Record<string, any> = req.validationErrors();

      if (errors) {
         res.status(400).json({
            error: errors
         });
         return;
      }

      const existingChat = await Chat.findOne({ chatname: cname });
      if (existingChat) {
         res.status(400).json({
            error: `A chat called '${cname}' already exists.`
         });
         return;
      }

      let users: Array<any> = [];

      for (let usern of usernames) {
         const found = await User.findOne({ username: usern });
         if (!found) {
            res.status(400).json({
               error: [{ msg: `User '${usern}' not found.` }]
            });
            return;
         }
         users.push({ username: usern, user: found });
      }

      let newChat: IChat = new Chat({
         chatname: cname,
         img: img || '',
         users: users,
         messages: []
      });

      await Chat.newChat(newChat, (err: Error, chat: IChat) => {
         if (err) {
            res.status(400).json({
               error: err
            });
            return;
         }

         res.status(201).json({
            chat: newChat
         });
      });
   }

   private async addUser(req: Request, res: Response): Promise<void> {
      const id = req.params.id;
      const username = req.body.username;

      req.checkBody('username', 'Must add at least one other user.').notEmpty();
      const errors: Record<string, any> = req.validationErrors();

      if (errors) {
         res.status(400).json({
            error: errors
         });
         return;
      }

      const validUser = await User.findOne({ username });
      if (!validUser) {
         res.status(400).json({
            error: [{ msg: `User '${username}' not found.` }]
         });
         return;
      }

      const chat = await Chat.findById(req.params.id, {
         users: { $elemMatch: { username: username } }
      });

      if (!chat) {
         res.status(400).json({
            error: [{ msg: `Chat '${id}' was not found.` }]
         });
         return;
      }

      if (chat.users.length) {
         res.status(400).json({
            error: `The user '${username}' is already in the chat.`
         });
         return;
      }

      const user = await User.findOne({ username });

      Chat.findOneAndUpdate(
         { _id: id },
         { $push: { users: { username, user } } },
         (err: Error, chat: IChat) => {
            if (err) {
               res.status(400).json({
                  error: err
               });
               return;
            }

            res.status(201).json({
               msg: `User '${username}' added!`
            });
         }
      );
   }

   private async removeUser(req: Request, res: Response): Promise<void> {
      const id = req.params.id;
      const username = req.body.username;

      req.checkBody('username', 'Must add at least one other user.').notEmpty();
      const errors: Record<string, any> = req.validationErrors();

      if (errors) {
         res.status(400).json({
            error: errors
         });
         return;
      }

      const validUser = await User.findOne({ username });
      if (!validUser) {
         res.status(400).json({
            error: [{ msg: `User '${username}' not found.` }]
         });
         return;
      }

      const chat = await Chat.findById(req.params.id, {
         users: { $elemMatch: { username: username } }
      });

      if (!chat) {
         res.status(400).json({
            error: [{ msg: `Chat '${id}' was not found.` }]
         });
         return;
      }

      if (chat.users.length === 0) {
         res.status(400).json({
            error: `The user '${username}' is not in the chat.`
         });
         return;
      }

      Chat.findOneAndUpdate(
         { _id: id },
         { $pull: { users: { username } } },
         (err: Error, chat: IChat) => {
            if (err) {
               res.status(400).json({
                  error: err
               });
               return;
            }

            res.status(200).json({
               msg: `User ${username} removed!`
            });
         }
      );
   }

   private async chatInfo(req: Request, res: Response): Promise<void> {
      const id = req.params.id;
      const chatInfo = await Chat.findById(id).populate('users.user');
      if (!chatInfo) {
         res.status(404).json({
            error: `A chat with the id '${id}' could not be found.`
         });
         return;
      }
      res.json(chatInfo);
   }

   private async sendMessage(req: Request, res: Response): Promise<void> {
      const id = req.params.id;

      req.checkBody('content', 'Message must have content.').notEmpty();
      req.checkBody('media', 'Message must specify content.').notEmpty();

      const errors: Record<string, any> = req.validationErrors();

      if (errors) {
         res.status(400).json({
            error: errors
         });
         return;
      }

      let newMessage: IMessage = {
         sentBy: res.locals.username,
         content: req.body.content,
         media: false,
         ts: new Date()
      };

      Chat.findOneAndUpdate(
         { _id: id },
         { $push: { messages: { ...newMessage } } },
         (err: Error, chat: IChat) => {
            if (err) {
               res.status(400).json({
                  error: err
               });
               return;
            }

            res.status(200).json({
               msg: `Message '${newMessage.content}' sent!`
            });
         }
      );
   }

   private async uploadPhoto(req: Request, res: Response): Promise<void> {
      if (!req.file) {
         res.status(400).json({
            error: [{ msg: 'You must specify a file to upload.' }]
         });
         return;
      }
      if (!/^image\/(jpe?g|png|gif)$/i.test(req.file.mimetype)) {
         res.status(400).json({
            error: [{ msg: 'File must be an image.' }]
         });
         return;
      }
      const fileName = `${req.params.id}-${uuidv4()}.${req.file.mimetype.slice(
         6
      )}`;

      await bucket.putObject(
         {
            ACL: 'public-read',
            Body: req.file.buffer,
            Key: fileName,
            Bucket: process.env.AWS_BUCKET_NAME
         },
         (err, data) => {
            if (err) {
               res.status(500).json({
                  error: [{ msg: err }]
               });
               return;
            }
            res.status(201).json({ fileName });
         }
      );
   }

   private routes(): void {
      this.router.post('/new', this.createChat);
      this.router.post('/add/:id', this.authReq, this.addUser);
      this.router.post('/remove/:id', this.authReq, this.removeUser);
      this.router.post('/send/:id', this.authReq, this.sendMessage);
      this.router.post(
         '/photo/:id',
         this.authReq,
         upload.single('img'),
         this.uploadPhoto
      );
      this.router.get('/:id', this.authReq, this.chatInfo);
   }
}
