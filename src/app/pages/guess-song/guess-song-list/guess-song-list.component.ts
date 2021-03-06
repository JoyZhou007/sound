import { Component, OnInit, ViewChild, ElementRef, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { toSeconds, replaceChat, shuffle, setLocalStorage, getLocalStorage } from 'src/app/core/common/utils';
import { songsList, Song } from './song';
import { AppGuessSongService, SongStatus } from '../guess-song.service';
import { EventService } from 'src/app/core/service/event.service';
import { AppSettingService } from 'src/app/core/service/setting.service';
import { NzMessageService } from 'ng-zorro-antd';


@Component({
  selector: 'app-guess-song-list',
  templateUrl: './guess-song-list.component.html',
  styleUrls: ['guess-song-list.component.scss']
})
export class AppGuessSongListComponent implements OnInit, OnDestroy {
  private unsubscribe$ = new Subject<void>();
  private playingSong: Song; // 正在播放的歌曲
  private audio = new Audio();
  private playDelay = 0;
  private validCheckTimer: NodeJS.Timer;
  private pauseTimer: NodeJS.Timer; // 暂停定时器, 淡出时0.5秒后执行暂停
  private fadeOutTimer: NodeJS.Timer; // 淡出定时器, 每隔0.1秒减弱0.2的音量, 来模拟淡出
  private fadeInTimer: NodeJS.Timer; // 淡入定时器, 同上
  private progressTimer: NodeJS.Timer; // 定时发送歌曲播放进度
  private canPlay = true; // 是否允许播放歌曲
  private rightList: number[]; // 已解锁歌曲的id序号数组
  private playingTimes: number; // 歌曲播放的总次数
  private playingSpecial = false; // 是否正在播特殊歌曲
  /** 说起来有点复杂...大概就是点下一首时, 理论上进度条清空后等下一首歌曲的进度传输. 因为程序执行需要时间, 在下一首播放之前已经清空了进度条, 但是之前播放的歌曲还是发送了进度信息过来, 导致刚刚点完下一首, 一大截进度跳过去了... */
  private stopTransfer = true; // 当为true时, 停止向进度条传送歌曲进度.

  public guessing = false; // true: 正在猜歌
  public pause: boolean; // true: 播放, false: 暂停
  public songsList: Song[] = [];
  public tipText = '尚未解锁该歌曲, 仅能听副歌部分, 即将播放下一首~'; // 提示文案

  @ViewChild('guessInput', { static: false }) input: ElementRef;

  // 确认是否选中
  public listClickHandler(index: number): void {
    this.songsList.forEach(v => v.selected = false);
    this.songsList[index].selected = true;
  }

  // 双击歌曲条目
  public tryToPlay(item: Song): void {
    if (this.playingSpecial) {
      this.appGuessSongService.message('用心感受, 别出小差!');
      return;
    }
    // 如果双击的曲目和当前播放的曲目不同, 则立刻播放
    if (this.playingSong !== item) {
      this.playAudio(item);
      return;
    }
    // 按照网易云的设定, 正在播放的歌曲双击无效果
    if (!this.audio.paused) {
      return;
    }
    // 如果该歌曲已解锁, 则继续播放
    if (item.right) {
      this.appGuessSongService.playingStatus$.next(SongStatus.play);
      return;
    }
    // 若未解锁, 则校验当前暂停是否处于合法区间的
    const startTime = toSeconds(item.startTime);
    const endTime = toSeconds(item.endTime);
    const currentTime = this.audio.currentTime;
    if (currentTime >= startTime && currentTime <= endTime) { // 当前播放进度处在合法范围内
      this.appGuessSongService.playingStatus$.next(SongStatus.play);
    } else { // 不合法则重新播放
      this.playAudio(item);
    }
  }

  // #region 猜题相关
  // 点击开锁, 准备答题
  public guessStart(item: Song): void {
    if (this.playingSpecial) {
      this.appGuessSongService.message('用心感受, 别出小差!');
      return;
    }
    if (item.right) {
      return;
    }
    this.guessing = true;
    if (this.canPlay) {
      item.guessing = true;
      setTimeout(() => this.input.nativeElement.focus());
      // 如果解锁的歌曲
      if (item !== this.playingSong) {
        this.playAudio(item);
      } else {
        if (this.audio.paused) {
          this.appGuessSongService.playingStatus$.next(SongStatus.play);
        }
      }
    }
  }

  // 失焦的时候
  public guessingBluerHandler(): void {
    this.guessing = false;
    this.songsList.forEach((item, _index) => item.guessing = false);
  }

  // 使用了钥匙, 直接开锁
  public openLock(item: Song): void {
    if (this.playingSong === item) {
      clearInterval(this.validCheckTimer);
      this.unLock(item);
    } else {
      this.unLock(item);
      this.playAudio(item);
    }
    this.appGuessSongService.keyExpend$.next();
  }

  // 校验答案
  public guessSong(answer: string, item: Song, index: number): void {
    let right = false;
    item.name.forEach(v => {
      if (v.toLowerCase() === answer.toLowerCase()) {
        this.unLock(item);
        right = true;
      }
    });
    if (!right) {
      this.nzMessageService.error('不对哦~ Try again!');
    }
  }

  /** 解锁歌曲 */
  private unLock(item: Song): void {
    item.right = true;
    clearInterval(this.validCheckTimer);
    this.rightList.push(item.id);
    setLocalStorage('rightList', this.rightList);
    this.appSettingService.addUserExp();
  }
  // #endregion

  // 播放歌曲
  public playAudio(item: Song): void {
    const startTime = toSeconds(item.startTime);
    const endTime = toSeconds(item.endTime) - 0.5; // - 0.5是为了适应淡出的时间
    this.songsList.forEach(v => v.playing = false);
    this.songsList.find(v => v.src === item.src).playing = true;
    this.playingSong = item;
    // 如果歌曲正在播放则淡出
    if (!this.audio.paused) {
      this.fadeOut();
      this.playDelay = 500; // 如果淡出则延迟0.5秒淡入
    }
    // 加载新歌曲资源
    setTimeout(() => {
      this.playDelay = 0; // 恢复默认值
      this.audio.src = item.src;
      this.appGuessSongService.playNewSong$.next(true);
      this.audio.load();
      clearInterval(this.validCheckTimer); // 先清除之前的'播放区间合法校验器'
      if (!item.right) { // 如果本歌曲尚未解锁, 则需要添加'播放区间合法校验器'
        this.audio.currentTime = startTime;
        // 当播放进度超出合法范围时, 停止播放
        this.validCheckTimer = setInterval(() => {
          if (endTime <= (this.audio.currentTime + 5)) {
            this.appGuessSongService.message('尚未解锁该歌曲, 仅能听副歌部分, 即将播放下一首');
          }
          if (this.audio.currentTime > endTime) {
            this.fadeOut();
            clearInterval(this.validCheckTimer);
          }
        }, 1000);
      }
      this.appGuessSongService.resetProgress$.next();
      this.appGuessSongService.playingStatus$.next(SongStatus.play);
    }, this.playDelay);
  }

  /** 淡出 0.5s */
  private fadeOut(): void {
    this.clearTimer();
    let volume = 1;
    this.audio.volume = volume;
    this.fadeOutTimer = setInterval(() => {
      volume -= 0.2;
      this.audio.volume = volume > 0 ? volume : 0;
      if (volume <= 0) {
        clearInterval(this.fadeOutTimer);
      }
    }, 100);
    this.pauseTimer = setTimeout(() => {
      this.audio.pause();
    }, 500);
  }

  /** 淡入 0.5s */
  private fadeIn(): void {
    this.clearTimer();
    this.audio.play();
    let volume = 0;
    this.audio.volume = volume;
    this.fadeInTimer = setInterval(() => {
      volume += 0.2;
      this.audio.volume = volume > 1 ? 1 : volume;
      if (volume >= 1) {
        clearInterval(this.fadeInTimer);
      }
    }, 100);
  }

  /** 播放下一首歌 */
  private nextSong(): void {
    const playingSongIndex = this.songsList.findIndex(v => v.playing);
    this.songsList.forEach(v => v.playing = false);
    this.playAudio(this.songsList[playingSongIndex === this.songsList.length - 1 ? 0 : playingSongIndex + 1]);
  }

  /** 一些临界状态的变化会被定时器干扰, 统一清除所有的定时器 */
  private clearTimer(): void {
    clearTimeout(this.pauseTimer);
    clearTimeout(this.fadeOutTimer);
    clearTimeout(this.fadeInTimer);
  }

  constructor(
    private appGuessSongService: AppGuessSongService,
    private eventService: EventService,
    private appSettingService: AppSettingService,
    private nzMessageService: NzMessageService
  ) { }

  ngOnInit(): void {
    // 读取本地歌曲乱序信息
    const localSongList = getLocalStorage('sortIds') as number[] || [];
    if (localSongList.length === 0) {
      const sortSongList = shuffle(songsList) as Song[];
      const sortIds = sortSongList.map(v => v.id);
      setLocalStorage('sortIds', sortIds);
      this.songsList = songsList;
    } else {
      localSongList.forEach(v => {
        const findSong = songsList.find(song => song.id === v);
        this.songsList.push(findSong);
      });
    }
    // 防作弊
    this.songsList.map(v => v.fakeTitle = v.title);
    this.songsList.map((item, i) => {
      const titleLength = item.title.length;
      const fakeTitle = '还想作弊?';
      let point = 0; // 代表fakeTitle当前需要使用的字符下标
      for (let index = 0; index < titleLength; index++) {
        item.fakeTitle = replaceChat(item.fakeTitle, index, fakeTitle[point]);
        if (point++ > fakeTitle.length - 2) {
          point = 0;
        }
      }
    });
    this.playingTimes = Number.parseInt(getLocalStorage('playingTimes'), 10) || 0;
    // 监听空格键, 切换播放/暂停状态, [初次打开, 正在猜歌, 正在播放特殊歌曲]等情况不响应
    this.eventService.blankKeydown$.pipe(takeUntil(this.unsubscribe$)).subscribe(v => {
      if (this.playingSong && !this.guessing && !this.playingSpecial) {
        this.appGuessSongService.playingStatus$.next(this.audio.paused ? SongStatus.play : SongStatus.pause);
      }
    });
    // 读取本地已答对歌曲数据
    this.rightList = getLocalStorage('rightList') || [];
    this.rightList.forEach(v1 => {
      this.songsList.map(v2 => {
        if (v2.id === v1) {
          v2.right = true;
        }
      });
    });
    // 更新歌曲播放进度条
    this.progressTimer = setInterval(() => {
      if (this.audio.duration && !this.audio.paused && !this.stopTransfer) { // 播放歌曲时, 一开始传递的duration是NaN, 导致进度条总时间重置为0
        this.appGuessSongService.progressChange$.next({
          currentTime: this.audio.currentTime,
          duration: this.audio.duration
        });
      }
    }, 1000);
    // #region 监听Audio原生对象方法
    // 监听歌曲结束时, 切下一首歌
    this.audio.onpause = () => {
      const playingSong = this.songsList.find(v => v.playing);
      if (!playingSong.right) {
        // 要判断当前的暂停是否是超出合法范围引起的, 若为人工暂停则无需下一首
        if (this.audio.currentTime >= toSeconds(playingSong.endTime) - 1) {
          this.nextSong();
        }
      } else {
        // 已解锁的歌曲, 只有歌曲唱完才下一首
        if (this.audio.currentTime === this.audio.duration) {
          this.nextSong();
        }
      }
    };
    // 监听歌曲缓冲进度
    this.audio.onprogress = () => {
      const timeRanges = this.audio.buffered;
      if (timeRanges.length > 0 && !this.stopTransfer) {
        const index = timeRanges.length - 1;
        this.appGuessSongService.bufferChange$.next({
          bufferTime: timeRanges.end(index > 0 ? index : 0),
          duration: this.audio.duration
        });
      }
    };
    this.audio.onloadeddata = () => {
      this.stopTransfer = false;
      this.playingTimes++;
      setLocalStorage('playingTimes', this.playingTimes);
      this.appGuessSongService.playNewSong$.next(false);
    };
    // #endregion
    /** 监听歌曲状态变更 */
    this.appGuessSongService.playingStatus$.pipe(takeUntil(this.unsubscribe$)).subscribe(status => {
      switch (status) {
        case SongStatus.privious:
          this.stopTransfer = true;
          const playingSongIndex = this.songsList.findIndex(v => v.playing);
          this.songsList.forEach(v => v.playing = false);
          this.playAudio(this.songsList[playingSongIndex === 0 ? this.songsList.length - 1 : playingSongIndex - 1]);
          break;
        case SongStatus.pause:
          this.stopTransfer = true;
          this.clearTimer();
          this.pause = true;
          this.fadeOut();
          break;
        case SongStatus.play:
          this.stopTransfer = false;
          if (this.playingSpecial) {
            this.appGuessSongService.message('用心感受, 别出小差!');
            return;
          }
          if (this.audio.src) {
            this.clearTimer();
            this.pause = false;
            this.fadeIn();
          } else {
            this.playAudio(this.songsList[0]);
          }
          break;
        case SongStatus.next:
          this.stopTransfer = true;
          this.nextSong();
          break;
      }
    });
    // 监听特殊歌曲
    this.appGuessSongService.specialSong$.pipe(takeUntil(this.unsubscribe$)).subscribe(v => {
      if (v) {
        this.playingSpecial = true;
        this.appGuessSongService.playingStatus$.next(SongStatus.pause);
        // 表明当前正在播放特殊歌曲
        this.playingSpecial = true;
      } else {
        this.playingSpecial = false;
      }
    });
    this.appGuessSongService.updatePlayingCurrentTime$.pipe(takeUntil(this.unsubscribe$)).subscribe(v => {
      const startTime = toSeconds(this.playingSong.startTime);
      const endTime = toSeconds(this.playingSong.endTime);
      if ((v >= startTime && v <= endTime) || this.playingSong.right) {
        this.audio.currentTime = v;
      } else {
        if (v <= startTime) {
          this.audio.currentTime = toSeconds(this.playingSong.startTime);
        }
        this.appGuessSongService.message('进度超出合法范围了哦~');
      }
    });
    this.appGuessSongService.unlockAll$.subscribe(() => {
      clearInterval(this.validCheckTimer);
      this.songsList.forEach(v => {
        if (!v.right) {
          v.right = true;
          this.rightList.push(v.id);
        }
      });
      setLocalStorage('rightList', this.rightList);
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.progressTimer);
    this.unsubscribe$.next();
    this.unsubscribe$.complete();
    this.fadeOut();
  }
}
