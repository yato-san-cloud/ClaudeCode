/*
 * Decompiled with CFR 0.152.
 * 
 * Could not load the following classes:
 *  sun.misc.Cleaner
 */
package com.hitachi.warehouse.mapmaker;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapFrame;
import com.hitachi.warehouse.gui.mapframe.panels.WorldMapPanel;
import com.hitachi.warehouse.mapmaker.FloorTab;
import com.hitachi.warehouse.mapmaker.FloorToolBar;
import com.hitachi.warehouse.mapmaker.OperationMode;
import com.hitachi.warehouse.mapmaker.OperationModeToolBar;
import com.hitachi.warehouse.mapmaker.StairsBetweenDistance;
import com.hitachi.warehouse.mapmaker.WorldMapExtension;
import com.hitachi.warehouse.mapmaker.WorldMapMultiFloor;
import com.hitachi.warehouse.mapmaker.commands.ShelfSearchManager;
import com.hitachi.warehouse.mapmaker.commands.StairsLinkManeger;
import com.hitachi.warehouse.mapmaker.commands.WaypointsCheckManager;
import com.hitachi.warehouse.mapmaker.common.NumericCheck;
import com.hitachi.warehouse.mapmaker.editors.AbstractObjectEditor;
import com.hitachi.warehouse.mapmaker.editors.AbstractObjectEditorExtension;
import com.hitachi.warehouse.mapmaker.editors.ObjectInfoFrame;
import com.hitachi.warehouse.mapmaker.exporters.MapCsvExporter;
import com.hitachi.warehouse.mapmaker.exporters.NagaharaExporter;
import com.hitachi.warehouse.mapmaker.importers.MapCsvImporter;
import com.hitachi.warehouse.mapmaker.networkgenerator.NetworkCalculatorManager;
import com.hitachi.warehouse.mapmaker.panels.AddObjectPanel;
import com.hitachi.warehouse.mapmaker.panels.BeaconEditorPanel;
import com.hitachi.warehouse.mapmaker.panels.DebugPanel;
import com.hitachi.warehouse.mapmaker.panels.DistanceSetPanel;
import com.hitachi.warehouse.mapmaker.panels.PeopleAnimation;
import com.hitachi.warehouse.mapmaker.panels.RulerPanel;
import com.hitachi.warehouse.mapmaker.panels.ScalingPanel;
import com.hitachi.warehouse.mapmaker.panels.VoronoiPanel;
import com.hitachi.warehouse.mapmaker.panels.objecteditor.ObjectEditorPanel;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Bound;
import com.hitachi.warehouse.model.map.MapProxy;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.ImageObject;
import com.hitachi.warehouse.tools.MapUpgrader;
import com.sun.pdfview.PDFFile;
import com.sun.pdfview.PDFPage;
import common.file.FileChooser;
import common.gui.InputDialog;
import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.GraphicsEnvironment;
import java.awt.Image;
import java.awt.Rectangle;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.geom.Rectangle2D;
import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import javax.imageio.ImageIO;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JMenu;
import javax.swing.JMenuItem;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.KeyStroke;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.ParserConfigurationException;
import net.iharder.dnd.FileDrop;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.SAXException;

public class MapMaker
implements WorldMap.WorldMapChangedListener,
MapProxy {
    boolean isCatchMemoryError;
    private static final String ERROR_MSG_UNSUPPORTED_FILETYPE = "未サポートの拡張子のファイルが指定されました。";
    public final MapFrame mapFrame;
    public final WorldMapPanel pnlWorldMap;
    private final List<AbstractMapPanel> panelsForCurrentOperationMode = new ArrayList<AbstractMapPanel>();
    public final FloorToolBar floorToolBar;
    public double ObjectMinHeightSize = 300.0;
    public double ObjectMinWidthSize = 300.0;
    public boolean ShowFloorName = true;
    public boolean ShowCalcStatus = true;
    public final OperationModeToolBar toolbar;
    public ObjectInfoFrame objectInfoFrame;
    public ObjectInfoFrame objectInfoFrameExtension;
    private final NetworkCalculatorManager calculatorManager;
    public PeopleAnimation peopleAnimation;
    private ShelfSearchManager shelfSearchManager;
    private WaypointsCheckManager waypointsCheckManager;
    private boolean isDirty = false;
    private WorldMap map;
    public WorldMapMultiFloor worldMapMultiFloor = new WorldMapMultiFloor();
    private Object mapLock = new Object();
    private File outFile;
    private List<WorldMap.WorldMapChangedListener> mapChangedListeners = new ArrayList<WorldMap.WorldMapChangedListener>();
    private OperationMode mode = OperationMode.kView;
    private FileChooser fileChooser = new FileChooser();
    private String INITIAL_SETTING_FILE = "InitialSetting.xml";
    public UndoManager undoManager;

    public static void main(String[] args) {
        new MapMaker();
    }

    public WaypointsCheckManager getWaypointsCheckManager() {
        return this.waypointsCheckManager;
    }

    public MapMaker() {
        this.ReadInitialSettingFile();
        this.mapFrame = new MapFrame(this.map, 1200, 800);
        GraphicsEnvironment env = GraphicsEnvironment.getLocalGraphicsEnvironment();
        Rectangle desktopBounds = env.getMaximumWindowBounds();
        int windowWidth = 1200;
        int windowHeight = 800;
        if (windowWidth > desktopBounds.width) {
            windowWidth = desktopBounds.width;
        }
        if (windowHeight > desktopBounds.height) {
            windowHeight = desktopBounds.height;
        }
        this.mapFrame.setBounds(0, 0, windowWidth, windowHeight);
        java.awt.Rectangle savedBounds = Prefs.getRect("window.bounds");
        if (savedBounds != null && isOnScreen(savedBounds)) {
            this.mapFrame.setBounds(savedBounds);
        } else {
            this.mapFrame.setLocationRelativeTo(null);
        }
        if (Prefs.getBool("window.maximized", false)) {
            this.mapFrame.setExtendedState(this.mapFrame.getExtendedState() | java.awt.Frame.MAXIMIZED_BOTH);
        }
        this.mapFrame.addListener(new MapFrame.MapFrameListener(){

            @Override
            public boolean allowQuit() {
                MapMaker.this.saveWindowGeometry();
                if (MapMaker.this.isDirty) {
                    Object[] button = new String[]{"保存", "保存せず終了"};
                    int res = JOptionPane.showOptionDialog(MapMaker.this.mapFrame, "未保存の変更があります。保存しますか？", "確認", -1, 3, null, button, button[0]);
                    switch (res) {
                        case -1: {
                            return false;
                        }
                        case 0: {
                            return MapMaker.this.save();
                        }
                    }
                    return true;
                }
                return true;
            }
        });
        new FileDrop(this.mapFrame, new FileDrop.Listener(){

            @Override
            public void filesDropped(File[] arg0) {
                File inFile = null;
                File[] fileArray = arg0;
                int n = arg0.length;
                int n2 = 0;
                while (n2 < n) {
                    File f2 = fileArray[n2];
                    if (f2.exists()) {
                        inFile = f2;
                    }
                    ++n2;
                }
                if (inFile.getName().toLowerCase().endsWith("rmp")) {
                    MapMaker.this.loadRmp(inFile);
                } else if (inFile.getName().toLowerCase().endsWith("csv")) {
                    MapMaker.this.loadCsv(inFile);
                } else if (inFile.getName().toLowerCase().endsWith("rmpm")) {
                    MapMaker.this.loadRmpm(inFile);
                } else {
                    JOptionPane.showMessageDialog(null, MapMaker.ERROR_MSG_UNSUPPORTED_FILETYPE, "Error", 0);
                }
            }
        });
        this.pnlWorldMap = new WorldMapPanel(true, true, false).setShowBeacons(false).setShowShelfWaypoints(false);
        this.mapFrame.mapView.openChildView(this.pnlWorldMap);
        this.peopleAnimation = new PeopleAnimation(this);
        this.mapFrame.mapView.openChildView(this.peopleAnimation);
        this.mapFrame.mapView.openChildView(new ScalingPanel(this));
        JPanel pnlAlltoolbar = new JPanel();
        pnlAlltoolbar.setLayout(new BorderLayout());
        this.floorToolBar = new FloorToolBar(this);
        pnlAlltoolbar.add((Component)this.floorToolBar, "North");
        this.toolbar = new OperationModeToolBar(this);
        pnlAlltoolbar.add((Component)this.toolbar, "South");
        this.mapFrame.pnlMain.add((Component)pnlAlltoolbar, "North");
        this.objectInfoFrame = new ObjectInfoFrame();
        this.objectInfoFrame.setPreferredSize(new Dimension(300, 500));
        this.objectInfoFrame.setMinimumSize(new Dimension(300, 500));
        this.objectInfoFrame.setMaximumSize(new Dimension(300, 500));
        this.objectInfoFrameExtension = new ObjectInfoFrame();
        this.objectInfoFrameExtension.setPreferredSize(new Dimension(300, 40));
        this.objectInfoFrameExtension.setMinimumSize(new Dimension(300, 40));
        this.objectInfoFrameExtension.setMaximumSize(new Dimension(300, 40));
        this.objectInfoFrameExtension.setAlignmentY(1.0f);
        JPanel pnlEast = new JPanel();
        pnlEast.setLayout(new BoxLayout(pnlEast, 1));
        pnlEast.add(this.objectInfoFrame);
        pnlEast.add(Box.createVerticalGlue());
        pnlEast.add(this.objectInfoFrameExtension);
        this.mapFrame.pnlMain.add((Component)pnlEast, "East");
        JMenu menuFile = this.mapFrame.menuForName("File");
        JMenuItem itemNew = new JMenuItem("新規ファイル（初期化）");
        itemNew.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.openNewFile();
            }
        });
        itemNew.setAccelerator(KeyStroke.getKeyStroke(78, 128));
        menuFile.add((Component)itemNew, 0);
        JMenuItem itemLoad = new JMenuItem("開く");
        itemLoad.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.load();
            }
        });
        itemLoad.setAccelerator(KeyStroke.getKeyStroke(79, 128));
        menuFile.add((Component)itemLoad, 1);
        JMenuItem itemSave = new JMenuItem("保存");
        itemSave.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.save();
            }
        });
        itemSave.setAccelerator(KeyStroke.getKeyStroke(83, 128));
        menuFile.add((Component)itemSave, 2);
        JMenuItem itemSaveAs = new JMenuItem("名前を付けて保存");
        itemSaveAs.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.save(true);
            }
        });
        menuFile.add((Component)itemSaveAs, 3);
        JMenu menuExport = new JMenu("出力");
        menuExport.add(new JMenuItem("ロケメンテナンス用")).addActionListener(new ActionListener(){
            NagaharaExporter exporter = new NagaharaExporter();

            @Override
            public void actionPerformed(ActionEvent e) {
                new Thread(){

                    @Override
                    public void run() {
                        if (MapMaker.this.calculatorManager.isCalculating()) {
                            JOptionPane.showMessageDialog(MapMaker.this.mapFrame, "経路キャッシュ計算中です。しばらくお待ちください。\n計算が完了後、出力してください。", "エラー", 0);
                            return;
                        }
                        if (MapMaker.this.calculatorManager.isNeedsRecalc()) {
                            JOptionPane.showMessageDialog(MapMaker.this.mapFrame, "経路キャッシュ計算後、出力してください。", "エラー", 0);
                            return;
                        }
                        if (MapMaker.this.calculatorManager.isCatchMemoryError() && JOptionPane.showConfirmDialog(MapMaker.this.mapFrame, "全経路計算が出来ていない可能性があります。このまま保存しますか？", "警告", 2) != 0) {
                            return;
                        }
                        int shelf_Start_Cnt = 0;
                        for (WorldMapExtension worldMapExtension : MapMaker.this.worldMapMultiFloor.getWorldMapExtensionList()) {
                            WorldMap map = worldMapExtension.getWorldMap();
                            for (FreeShelfObject obj : map.freeShelfObjects()) {
                                if (!obj.shelf().name.equals("START")) continue;
                                ++shelf_Start_Cnt;
                            }
                        }
                        if (shelf_Start_Cnt == 0) {
                            JOptionPane.showMessageDialog(MapMaker.this.mapFrame, "STARTの棚がありません。", "エラー", 0);
                            return;
                        }
                        MapMaker.this.calculatorManager.setCalculationStop(true);
                        MapMaker.this.worldMapMultiFloor.AllFloorCalc(true);
                        String errorMessage = null;
                        for (String str : MapMaker.this.worldMapMultiFloor.allFloorCalc_ErrorInfo) {
                            if (str == null) continue;
                            if (errorMessage == null) {
                                errorMessage = "経路キャッシュ計算でエラーが発生しました。\n\n";
                            }
                            errorMessage = String.valueOf(errorMessage) + str + "\n";
                        }
                        if (errorMessage != null) {
                            JOptionPane.showMessageDialog(MapMaker.this.mapFrame, errorMessage, "エラー", 0);
                            MapMaker.this.calculatorManager.setCalculationStop(false);
                            return;
                        }
                        ArrayList<String> errorMessage_createCartGraph = MapMaker.this.worldMapMultiFloor.CreateMultiFloorStairsCartGraph();
                        errorMessage = null;
                        for (String str : errorMessage_createCartGraph) {
                            if (str == null) continue;
                            if (errorMessage == null) {
                                errorMessage = "フロアー間の階段の接続に問題があります。\n\n";
                            }
                            errorMessage = String.valueOf(errorMessage) + str + "\n";
                        }
                        if (errorMessage != null) {
                            JOptionPane.showMessageDialog(MapMaker.this.mapFrame, errorMessage, "エラー", 0);
                            MapMaker.this.calculatorManager.setCalculationStop(false);
                            return;
                        }
                        for (StairsBetweenDistance stairsBetweenDistance : MapMaker.this.worldMapMultiFloor.StairsBetweenDistanceList) {
                            if (stairsBetweenDistance.Distance != 0.0) continue;
                            JOptionPane.showMessageDialog(MapMaker.this.mapFrame, "階段の距離が不正です。\n設定メニューのフロアー間接続で距離を変更してください。", "エラー", 0);
                            MapMaker.this.calculatorManager.setCalculationStop(false);
                            return;
                        }
                        exporter.export(MapMaker.this.worldMapMultiFloor);
                        MapMaker.this.mapFrame.mapView.setMessage("Export finished!");
                        MapMaker.this.calculatorManager.setCalculationStop(false);
                    }
                }.start();
            }
        });
        menuExport.add(new JMenuItem("CSV地図ファイル")).addActionListener(new ActionListener(){
            MapCsvExporter exporter = new MapCsvExporter();

            @Override
            public void actionPerformed(ActionEvent e) {
                new Thread(){

                    @Override
                    public void run() {
                        exporter.exportFile(MapMaker.this.mapFrame, MapMaker.this.outFile);
                        MapMaker.this.mapFrame.mapView.setMessage("Export finished!");
                    }
                }.start();
            }
        });
        menuFile.add((Component)menuExport, 4);
        JMenu menuSeting = new JMenu("設定");
        final MapMaker mapMaker = this;
        menuSeting.add(new JMenuItem("階段の設定（接続と距離）")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                if (MapMaker.this.calculatorManager.isCalculating()) {
                    JOptionPane.showMessageDialog(MapMaker.this.mapFrame, "経路キャッシュ計算中です。しばらくお待ちください。\n計算が完了後、実行してください。", "エラー", 0);
                    return;
                }
                if (MapMaker.this.calculatorManager.isNeedsRecalc()) {
                    JOptionPane.showMessageDialog(MapMaker.this.mapFrame, "経路キャッシュ計算後、実行してください。", "エラー", 0);
                    return;
                }
                if (MapMaker.this.calculatorManager.isCatchMemoryError() && JOptionPane.showConfirmDialog(MapMaker.this.mapFrame, "全経路計算が出来ていない可能性があります。このまま実行しますか？", "警告", 2) != 0) {
                    return;
                }
                MapMaker.this.calculatorManager.setCalculationStop(true);
                StairsLinkManeger StairsLinkManeger2 = new StairsLinkManeger(mapMaker);
                StairsLinkManeger2.open();
                MapMaker.this.calculatorManager.setCalculationStop(false);
            }
        });
        menuSeting.add(new JMenuItem("地図領域を設定（倉庫サイズ）")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.askAndSetBounds();
            }
        });
        menuSeting.add(new JMenuItem("背景画像を設定")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.requestFileAndSetBackgroundImage();
            }
        });
        JMenuItem itemImport = new JMenuItem(".rmp／.csvの取込み");
        itemImport.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.importFile();
            }
        });
        menuSeting.add(itemImport);
        menuSeting.add(new JMenuItem("棚名リストの取込み")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.requestFileAndLoadShelfNames();
            }
        });
        menuSeting.add(new JMenuItem("棚名リストの編集")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.map().shelfNameManager().openEditor();
            }
        });
        menuSeting.addSeparator();
        menuSeting.add(new JMenuItem("背景画像をクリア")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.clearBackgroundImage();
            }
        });
        this.mapFrame.menuBar.add(menuSeting);
        this.mapFrame.menuBar.revalidate();
        JMenu menuShow = new JMenu("表示");
        MapMaker mapMaker2 = this;
        menuShow.add(new JMenuItem("フロアー名表示　　　　（ON/OFF）")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.ShowFloorName = !MapMaker.this.ShowFloorName;
            }
        });
        menuShow.add(new JMenuItem("人流アニメーション　　（ON/OFF）")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.peopleAnimation.changeDrawingAnimation();
            }
        });
        mapMaker2 = this;
        menuShow.add(new JMenuItem("経路計算状況表示　　　（ON/OFF）")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.ShowCalcStatus = !MapMaker.this.ShowCalcStatus;
            }
        });
        menuShow.add(new JMenuItem("経路キャッシュ自動計算（ON/OFF）")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.calculatorManager.changeExecuteCalc();
                if (MapMaker.this.calculatorManager.getExecuteCalc()) {
                    MapMaker.this.toolbar.getbtnStartNetworkGenerator().setEnabled(false);
                } else {
                    MapMaker.this.toolbar.getbtnStartNetworkGenerator().setEnabled(true);
                }
            }
        });
        this.mapFrame.menuBar.add(menuShow);
        this.mapFrame.menuBar.revalidate();
        JMenu menuSearch = new JMenu("検索");
        final MapMaker mapMaker3 = this;
        menuSearch.add(new JMenuItem("商品のピック面数チェック")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                if (MapMaker.this.waypointsCheckManager == null) {
                    MapMaker.this.waypointsCheckManager = new WaypointsCheckManager(mapMaker3);
                }
                MapMaker.this.waypointsCheckManager.open();
            }
        });
        menuSearch.add(new JMenuItem("棚名検索")).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                if (MapMaker.this.shelfSearchManager == null) {
                    MapMaker.this.shelfSearchManager = new ShelfSearchManager(mapMaker3);
                }
                MapMaker.this.shelfSearchManager.open();
            }
        });
        this.mapFrame.menuBar.add(menuSearch);
        this.mapFrame.menuBar.revalidate();
        this.mapFrame.mapView.addKeyListener(new KeyAdapter(){

            @Override
            public void keyTyped(KeyEvent e) {
                OperationMode mode;
                char k = e.getKeyChar();
                if (k >= '1' && k <= '9' && (mode = MapMaker.this.toolbar.modeAtIdx(k - 49)) != null) {
                    MapMaker.this.setOperationMode(mode);
                }
            }
        });
        this.calculatorManager = new NetworkCalculatorManager(this, this);
        this.calculatorManager.start();
        if (this.calculatorManager.getExecuteCalc()) {
            this.toolbar.getbtnStartNetworkGenerator().setEnabled(false);
        } else {
            this.toolbar.getbtnStartNetworkGenerator().setEnabled(true);
        }
        this.forceOpenNewFile();
        this.setOperationMode(OperationMode.kEditRect);
        this.floorToolBar.addAfter(this.floorToolBar.getNewFloorTab(), this.map);
        this.undoManager = new UndoManager(this);
        this.installUndoMenu();
        this.mapFrame.repaint();
        this.mapFrame.validate();
    }

    private void installUndoMenu() {
        JMenu menuEdit = new JMenu("編集");
        JMenuItem itemUndo = new JMenuItem("元に戻す");
        itemUndo.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.undoManager.undo();
            }
        });
        itemUndo.setAccelerator(KeyStroke.getKeyStroke(90, 128));
        menuEdit.add(itemUndo);
        JMenuItem itemRedo = new JMenuItem("やり直し");
        itemRedo.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.undoManager.redo();
            }
        });
        itemRedo.setAccelerator(KeyStroke.getKeyStroke(89, 128));
        menuEdit.add(itemRedo);
        menuEdit.addSeparator();
        JMenuItem itemShelfGen = new JMenuItem("棚を一括生成…");
        itemShelfGen.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                ShelfArrayGenerator.open(MapMaker.this);
            }
        });
        itemShelfGen.setAccelerator(KeyStroke.getKeyStroke(66, 128));
        menuEdit.add(itemShelfGen);
        JMenuItem itemZoomFit = new JMenuItem("全体表示（全オブジェクト）");
        itemZoomFit.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.zoomToFitObjects();
            }
        });
        itemZoomFit.setAccelerator(KeyStroke.getKeyStroke(48, 128));
        menuEdit.add(itemZoomFit);
        JMenuItem itemLocNum = new JMenuItem("選択棚に連番ロケ…");
        itemLocNum.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapMaker.this.bulkLocationNumberingFromMenu();
            }
        });
        itemLocNum.setAccelerator(KeyStroke.getKeyStroke(76, 128));
        menuEdit.add(itemLocNum);
        this.mapFrame.menuBar.add(menuEdit, 1);
        this.mapFrame.menuBar.revalidate();
    }

    private void zoomToFitObjects() {
        WorldMap map = this.map;
        if (map == null) {
            return;
        }
        Double l = null, t = null, r = null, b = null;
        try {
            map.startRead();
            for (AbstractObject o : map.objects()) {
                Coord tl = o.boundTL();
                Coord br = o.boundBR();
                l = l == null ? tl.x : Math.min(l, tl.x);
                t = t == null ? tl.y : Math.min(t, tl.y);
                r = r == null ? br.x : Math.max(r, br.x);
                b = b == null ? br.y : Math.max(b, br.y);
            }
        } finally {
            map.endRead();
        }
        if (l == null) {
            this.mapFrame.mapView.showRect(map.tl(), map.br(), 300L);
            return;
        }
        this.mapFrame.mapView.showBounds(new Coord(l, t), new Coord(r, b), 1.1, 0.5, 300L);
    }

    private void saveWindowGeometry() {
        try {
            int st = this.mapFrame.getExtendedState();
            boolean max = (st & java.awt.Frame.MAXIMIZED_BOTH) == java.awt.Frame.MAXIMIZED_BOTH;
            Prefs.putBool("window.maximized", max);
            if (!max) {
                Prefs.putRect("window.bounds", new java.awt.Rectangle(this.mapFrame.getX(), this.mapFrame.getY(), this.mapFrame.getWidth(), this.mapFrame.getHeight()));
            }
            Prefs.save();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private static boolean isOnScreen(java.awt.Rectangle r) {
        for (java.awt.GraphicsDevice gd : java.awt.GraphicsEnvironment.getLocalGraphicsEnvironment().getScreenDevices()) {
            if (gd.getDefaultConfiguration().getBounds().intersects(r)) {
                return true;
            }
        }
        return false;
    }

    private void bulkLocationNumberingFromMenu() {
        for (AbstractMapPanel p : this.panelsForCurrentOperationMode) {
            if (p instanceof ObjectEditorPanel) {
                ((ObjectEditorPanel) p).bulkLocationNumbering();
                return;
            }
        }
        JOptionPane.showMessageDialog(this.mapFrame, "「編集」モードで棚を範囲選択（Shift＋ドラッグ）してから実行してください。", "連番ロケ付与", 1);
    }

    public NetworkCalculatorManager getCalculatorManager() {
        return this.calculatorManager;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    protected void updateTitle() {
        Object object = this.mapLock;
        synchronized (object) {
            String title = String.valueOf(this.isDirty ? "* " : "") + (this.outFile == null ? "新規ファイル" : this.outFile.getAbsolutePath());
            if (!this.mapFrame.getTitle().equals(title)) {
                this.mapFrame.setTitle(title);
            }
        }
    }

    public void setDirty() {
        if (!this.isDirty) {
            this.isDirty = true;
            this.updateTitle();
        }
        this.mapFrame.repaint();
    }

    public WorldMap map() {
        return this.map;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void setMap(WorldMap map, boolean mapChange) {
        if (map == null) {
            return;
        }
        Object object = this.mapLock;
        synchronized (object) {
            if (this.map != null) {
                this.map.removeMapChangedListener(this);
            }
            this.map = map;
            this.mapFrame.setMap(map);
            this.calculatorManager.setMapNoRecalc(map);
            this.map.addMapChangedListener(this);
            if (mapChange) {
                this.mapChanged(this.map);
            }
            this.isDirty = false;
        }
        this.mapFrame.mapView.setCenter(Coord.mean(map.tl(), map.br()));
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    @Override
    public void addMapChangedListener(WorldMap.WorldMapChangedListener listener) {
        List<WorldMap.WorldMapChangedListener> list = this.mapChangedListeners;
        synchronized (list) {
            this.mapChangedListeners.add(listener);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    @Override
    public void removeMapChangedListener(WorldMap.WorldMapChangedListener listener) {
        List<WorldMap.WorldMapChangedListener> list = this.mapChangedListeners;
        synchronized (list) {
            this.mapChangedListeners.remove(listener);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    @Override
    public void mapChanged(WorldMap map) {
        this.setDirty();
        if (this.undoManager != null) {
            this.undoManager.onMapChanged();
        }
        List<WorldMap.WorldMapChangedListener> list = this.mapChangedListeners;
        synchronized (list) {
            for (WorldMap.WorldMapChangedListener listener : this.mapChangedListeners) {
                listener.mapChanged(map);
            }
        }
    }

    public OperationMode mode() {
        return this.mode;
    }

    public void setOperationMode(OperationMode mode) {
        if (this.mode == mode) {
            return;
        }
        this.resetOperationMode(mode);
    }

    public void resetOperationMode(OperationMode mode) {
        for (AbstractMapPanel abstractMapPanel : this.panelsForCurrentOperationMode) {
            this.mapFrame.mapView.closeChildview(abstractMapPanel);
        }
        this.panelsForCurrentOperationMode.clear();
        this.pnlWorldMap.setShowNetworks(false);
        this.pnlWorldMap.setShowShelfWaypoints(false);
        this.mode = mode;
        this.toolbar.updateStatus();
        this.objectInfoFrame.setEditor(null);
        this.objectInfoFrame.repaint();
        this.objectInfoFrameExtension.setEditor(null);
        this.objectInfoFrameExtension.repaint();
        this.mapFrame.revalidate();
        switch (mode) {
            case kView: {
                this.mapFrame.setCursor(new Cursor(0));
                break;
            }
            case kEditRect: {
                this.mapFrame.setCursor(new Cursor(1));
                this.panelsForCurrentOperationMode.add(new ObjectEditorPanel(this));
                break;
            }
            case kRulerCart: 
            case kRulerWalk: {
                this.mapFrame.setCursor(new Cursor(1));
                this.panelsForCurrentOperationMode.add(new RulerPanel(this));
                this.pnlWorldMap.setShowNetworks(true);
                this.pnlWorldMap.setShowShelfWaypoints(true);
                break;
            }
            case kAddShelf: 
            case kAddWall: 
            case kAddStation: 
            case kAddStairs: 
            case kAddConstrainedArea: {
                this.mapFrame.setCursor(new Cursor(1));
                this.panelsForCurrentOperationMode.add(new AddObjectPanel(this));
                break;
            }
            case kDebug: {
                this.mapFrame.setCursor(new Cursor(1));
                DebugPanel debugPanel = new DebugPanel(this);
                this.panelsForCurrentOperationMode.add(debugPanel);
                VoronoiPanel voronoiPanel = new VoronoiPanel(this);
                this.panelsForCurrentOperationMode.add(voronoiPanel);
                break;
            }
            case kEditBeacon: {
                this.mapFrame.setCursor(new Cursor(0));
                this.panelsForCurrentOperationMode.add(new BeaconEditorPanel(this));
                break;
            }
            case kDistanceSet: {
                this.mapFrame.setCursor(new Cursor(1));
                this.panelsForCurrentOperationMode.add(new DistanceSetPanel(this));
            }
        }
        for (AbstractMapPanel abstractMapPanel : this.panelsForCurrentOperationMode) {
            this.mapFrame.mapView.openChildView(abstractMapPanel);
        }
        this.mapFrame.mapView.requestFocus();
        this.mapFrame.repaint();
    }

    public void requestFileAndSetBackgroundImage() {
        File f2 = FileChooser.loadFileLocation("jpg", "gif", "png", "bmp", "pdf");
        if (f2 != null && f2.exists()) {
            if (!MapMaker.getSuffix(f2.getName()).toUpperCase().equals("PDF")) {
                try {
                    String[] split;
                    BufferedImage img = ImageIO.read(f2);
                    Coord tl = null;
                    Coord br = null;
                    String boundStr = InputDialog.showDialog(this.mapFrame, "背景画像の領域をmmで設定してください。", "[左], [上], [右], [下]", String.valueOf(this.map.tl().x) + "," + this.map.tl().y + "," + this.map.br().x + "," + this.map.br().y);
                    if (boundStr != null && (split = boundStr.split(",")).length == 4) {
                        try {
                            double l = Double.parseDouble(split[0]);
                            double t2 = Double.parseDouble(split[1]);
                            double r = Double.parseDouble(split[2]);
                            double b = Double.parseDouble(split[3]);
                            tl = new Coord(l, t2);
                            br = new Coord(r, b);
                        }
                        catch (Exception e) {
                            e.printStackTrace();
                        }
                    }
                    if (tl != null && br != null) {
                        ImageObject objImage = new ImageObject();
                        objImage.setImage(img);
                        objImage.setBounds(tl, br);
                        this.setBackgroundImage(objImage);
                    }
                }
                catch (Exception ex) {
                    ex.printStackTrace();
                }
            } else {
                this.requestFileAndSetBackgroundImage_PDF(f2);
            }
        }
    }

    public void clearBackgroundImage() {
        this.setBackgroundImage(null);
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void setBackgroundImage(ImageObject objImage) {
        Object object = this.mapLock;
        synchronized (object) {
            if (this.map != null) {
                try {
                    this.map.startWrite();
                    this.map.setBGImg(objImage);
                    this.setDirty();
                }
                finally {
                    this.map.endWrite();
                }
                this.mapFrame.repaint();
            }
        }
    }

    public void askAndSetBounds() {
        String[] split;
        String boundStr = InputDialog.showDialog(this.mapFrame, "Enter bounds", "left, top, right, bottom", String.valueOf(this.map.tl().x) + "," + this.map.tl().y + "," + this.map.br().x + "," + this.map.br().y);
        if (boundStr != null && (split = boundStr.split(",")).length == 4) {
            try {
                double l = Double.parseDouble(split[0]);
                double t2 = Double.parseDouble(split[1]);
                double r = Double.parseDouble(split[2]);
                double b = Double.parseDouble(split[3]);
                this.setBounds(new Coord(l, t2), new Coord(r, b));
            }
            catch (Exception e) {
                e.printStackTrace();
            }
        }
    }

    public void setBounds(Coord tl, Coord br) {
        try {
            this.map.startWrite();
            this.map.setBounds(tl, br);
            this.setDirty();
        }
        finally {
            this.map.endWrite();
        }
    }

    public void requestFileAndLoadShelfNames() {
        File f2;
        WorldMap map = this.map;
        if (map != null && (f2 = FileChooser.loadFileLocation("txt", "csv")) != null && f2.exists() && map.shelfNameManager().loadFromFile(f2)) {
            map.shelfNameManager().openEditor();
        }
    }

    public void showInfoForObject(AbstractObject obj, HashMap<AbstractObject, Bound> selectedObjectsOriginalBound) {
        if (obj != null) {
            this.objectInfoFrame.setVisible(true);
            AbstractObjectEditor<AbstractObject> editor = AbstractObjectEditor.openEditor(obj, this.map, this, selectedObjectsOriginalBound);
            this.objectInfoFrame.setEditor(editor);
            ArrayList<AbstractObject> editingObjects = new ArrayList<AbstractObject>();
            editingObjects.add(obj);
            AbstractObjectEditorExtension ExtEditer = new AbstractObjectEditorExtension(editor, editingObjects, this.map);
            this.objectInfoFrameExtension.setEditor(ExtEditer);
            this.objectInfoFrameExtension.repaint();
            this.objectInfoFrame.repaint();
            this.mapFrame.revalidate();
        } else {
            this.objectInfoFrame.setEditor(null);
            this.objectInfoFrame.repaint();
            this.objectInfoFrameExtension.setEditor(null);
            this.objectInfoFrameExtension.repaint();
            this.mapFrame.revalidate();
        }
    }

    public void showInfoForMultiObject(HashSet<AbstractObject> objs) {
        this.objectInfoFrame.setEditor(null);
        this.objectInfoFrame.repaint();
        ArrayList<AbstractObject> editingObjects = new ArrayList<AbstractObject>();
        for (AbstractObject obj : objs) {
            editingObjects.add(obj);
        }
        AbstractObjectEditorExtension ExtEditer = new AbstractObjectEditorExtension(null, editingObjects, this.map);
        this.objectInfoFrameExtension.setEditor(ExtEditer);
        this.objectInfoFrameExtension.repaint();
        this.mapFrame.revalidate();
    }

    public void showInfoForPanel(JPanel panel) {
        if (panel != null) {
            this.objectInfoFrame.setVisible(true);
            this.objectInfoFrame.setEditor(panel);
            this.objectInfoFrame.repaint();
            this.mapFrame.revalidate();
        } else {
            this.objectInfoFrame.setEditor(null);
            this.objectInfoFrame.repaint();
            this.mapFrame.revalidate();
        }
    }

    public void forceOpenNewFile() {
        this.setMap(new WorldMap(), true);
        this.outFile = null;
        this.updateTitle();
        if (this.undoManager != null) {
            this.undoManager.reset();
        }
    }

    public void openNewFile() {
        int res;
        if (this.isDirty && (res = JOptionPane.showConfirmDialog(this.mapFrame, "新しいファイルを開くと未保存の変更内容は失われます。本当に新しいファイルを開きますか？", "未保存の変更があります", 2)) == 0) {
            this.isDirty = false;
        }
        if (!this.isDirty) {
            this.forceOpenNewFile();
            this.floorToolBar.clear();
            this.floorToolBar.addAfter(this.floorToolBar.getNewFloorTab(), this.map);
            this.mapFrame.repaint();
            this.mapFrame.validate();
            AbstractObject._setIDAccum(0);
        }
    }

    public void load() {
        File f2;
        int res;
        if (this.isDirty && (res = JOptionPane.showConfirmDialog(this.mapFrame, "新しいファイルを開くと未保存の変更内容は失われます。本当に新しいファイルを開きますか？", "未保存の変更があります", 2)) == 0) {
            this.isDirty = false;
        }
        if (!this.isDirty && (f2 = this.fileChooser.requestLoadFileLocation("rmp", "rmpm", "csv")) != null) {
            if (f2.getName().toLowerCase().endsWith("rmp")) {
                this.loadRmp(f2);
            } else if (f2.getName().toLowerCase().endsWith("csv")) {
                this.loadCsv(f2);
            } else if (f2.getName().toLowerCase().endsWith("rmpm")) {
                this.loadRmpm(f2);
            } else {
                JOptionPane.showMessageDialog(null, ERROR_MSG_UNSUPPORTED_FILETYPE, "Error", 0);
            }
        }
    }

    public void importFile() {
        int res = JOptionPane.showConfirmDialog(this.mapFrame, "表示されているフロアーにファイルを取り込みます。よろしいですか？", "未保存の変更があります", 2);
        if (res == 2) {
            return;
        }
        File f2 = this.fileChooser.requestLoadFileLocation("rmp", "csv");
        if (f2 != null) {
            if (f2.getName().toLowerCase().endsWith("rmp")) {
                this.importRmp(f2);
            } else if (f2.getName().toLowerCase().endsWith("csv")) {
                this.importCsv(f2);
            } else {
                JOptionPane.showMessageDialog(null, ERROR_MSG_UNSUPPORTED_FILETYPE, "Error", 0);
            }
        }
    }

    public void loadRmp(File f2) {
        int res;
        if (this.isDirty && (res = JOptionPane.showConfirmDialog(this.mapFrame, "新しいファイルを開くと未保存の変更内容は失われます。本当に新しいファイルを開きますか？", "未保存の変更があります", 2)) == 0) {
            this.isDirty = false;
        }
        if (!this.isDirty) {
            try {
                AbstractObject._setIDAccum(0);
                WorldMap map = WorldMap.loadFrom(f2);
                map = MapUpgrader.updateVersion(map);
                this.setMap(map, true);
                this.outFile = f2;
                this.updateTitle();
                this.floorToolBar.clear();
                this.floorToolBar.addAfter(this.floorToolBar.getNewFloorTab(), map);
                this.mapFrame.repaint();
                this.mapFrame.validate();
                if (this.undoManager != null) {
                    this.undoManager.reset();
                }
            }
            catch (Exception e) {
                e.printStackTrace();
                JOptionPane.showMessageDialog(null, f2 + "を開くときに問題が起こりました。" + e.getMessage(), "ロードエラー", 0);
            }
        }
    }

    public void importRmp(File f2) {
        try {
            WorldMap map = WorldMap.loadFrom(f2);
            map = MapUpgrader.updateVersion(map);
            this.setMap(map, true);
            this.worldMapMultiFloor.getWorldMapExtension(this.floorToolBar.getCurrentFloorTabIndex()).setWorldMap(map);
        }
        catch (Exception e) {
            e.printStackTrace();
            JOptionPane.showMessageDialog(null, f2 + "を開くときに問題が起こりました。" + e.getMessage(), "ロードエラー", 0);
        }
    }

    public void loadRmpm(File f2) {
        try {
            WorldMapExtension worldMapExtension2;
            AbstractObject._setIDAccum(0);
            WorldMapMultiFloor worldMapMultiFloor = WorldMapMultiFloor.loadFrom(f2);
            this.floorToolBar.clear();
            for (WorldMapExtension worldMapExtensionLoop : worldMapMultiFloor.getWorldMapExtensionList()) {
                FloorTab newtab = this.floorToolBar.getNewFloorTab();
                newtab.setFloorName(worldMapExtensionLoop.getName());
                this.floorToolBar.addAfterTabOnly(newtab);
                worldMapExtensionLoop.getWorldMap().setCartGraph(null);
                newtab.getNetworkCalculatorManagerInfo().setNetworkCalculatorManagerInfo(true, null, null, false);
            }
            this.worldMapMultiFloor = worldMapMultiFloor;
            this.floorToolBar.setCurrentFloorTabIndex(0);
            worldMapExtension2 = worldMapMultiFloor.getWorldMapExtension(0);
            this.setMap(worldMapExtension2.getWorldMap(), true);
            this.outFile = f2;
            this.updateTitle();
            this.mapFrame.mapView.setOrientation(worldMapExtension2.getCenterX(), worldMapExtension2.getCenterY(), worldMapExtension2.getZoomLevel());
            if (this.undoManager != null) {
                this.undoManager.reset();
            }
        }
        catch (Exception e) {
            e.printStackTrace();
            JOptionPane.showMessageDialog(null, f2 + "を開くときに問題が起こりました。" + e.getMessage(), "エラー", 0);
        }
    }

    public void loadCsv(File f2) {
        int res;
        if (this.isDirty && (res = JOptionPane.showConfirmDialog(this.mapFrame, "新しいファイルを開くと未保存の変更内容は失われます。本当に新しいファイルを開きますか？", "未保存の変更があります", 2)) == 0) {
            this.isDirty = false;
        }
        if (!this.isDirty) {
            try {
                AbstractObject._setIDAccum(0);
                this.forceOpenNewFile();
                MapCsvImporter importer = new MapCsvImporter();
                importer.importFile(this.map, f2);
                this.floorToolBar.clear();
                this.floorToolBar.addAfter(this.floorToolBar.getNewFloorTab(), this.map);
                this.mapFrame.repaint();
                this.mapFrame.validate();
            }
            catch (Exception e) {
                e.printStackTrace();
                JOptionPane.showMessageDialog(null, f2 + "を開くときに問題が起こりました。" + e.getMessage(), "ロードエラー", 0);
            }
        }
    }

    public void importCsv(File f2) {
        try {
            this.forceOpenNewFile();
            MapCsvImporter importer = new MapCsvImporter();
            importer.importFile(this.map, f2);
            this.worldMapMultiFloor.getWorldMapExtension(this.floorToolBar.getCurrentFloorTabIndex()).setWorldMap(this.map);
        }
        catch (Exception e) {
            e.printStackTrace();
            JOptionPane.showMessageDialog(null, f2 + "を開くときに問題が起こりました。" + e.getMessage(), "ロードエラー", 0);
        }
    }

    public boolean save() {
        return this.save(false);
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public boolean save(boolean chooseFileLocation) {
        Object object = this.mapLock;
        synchronized (object) {
            block16: {
                block21: {
                    block23: {
                        block20: {
                            block19: {
                                block18: {
                                    block17: {
                                        if (this.worldMapMultiFloor == null) break block16;
                                        if (!this.calculatorManager.isCalculating()) break block17;
                                        JOptionPane.showMessageDialog(this.mapFrame, "経路キャッシュ計算中です。しばらくお待ちください。\n計算が完了後、出力してください。", "エラー", 0);
                                        return false;
                                    }
                                    if (!this.calculatorManager.isNeedsRecalc()) break block18;
                                    JOptionPane.showMessageDialog(this.mapFrame, "経路キャッシュ計算後、出力してください。", "エラー", 0);
                                    return false;
                                }
                                if (!this.calculatorManager.isCatchMemoryError() || JOptionPane.showConfirmDialog(this.mapFrame, "全経路計算が出来ていない可能性があります。このまま保存しますか？", "警告", 2) == 0) break block19;
                                return false;
                            }
                            if (this.outFile != null && !chooseFileLocation && (this.outFile == null || this.outFile.getName().endsWith(".rmpm") || chooseFileLocation)) break block20;
                            File f2 = this.fileChooser.requestFileLocation("rmpm");
                            if (f2 != null) {
                                if (!f2.getName().toLowerCase().endsWith("rmpm")) {
                                    f2 = new File(String.valueOf(f2.getPath()) + ".rmpm");
                                }
                                this.outFile = f2;
                                break block20;
                            }
                            return false;
                        }
                        if (this.outFile != null && !chooseFileLocation && !this.outFile.getName().toLowerCase().endsWith("rmpm")) {
                            this.outFile = new File(String.valueOf(this.outFile.getPath()) + ".rmpm");
                        }
                        if (this.outFile == null) break block21;
                        boolean result = false;
                        try {
                            this.worldMapMultiFloor.getWorldMapExtension(this.floorToolBar.getCurrentFloorTabIndex()).setCenterX(this.mapFrame.mapView.centerX());
                            this.worldMapMultiFloor.getWorldMapExtension(this.floorToolBar.getCurrentFloorTabIndex()).setCenterY(this.mapFrame.mapView.centerY());
                            this.worldMapMultiFloor.getWorldMapExtension(this.floorToolBar.getCurrentFloorTabIndex()).setZoomLevel(this.mapFrame.mapView.zoomLevel());
                            this.worldMapMultiFloor.startWrite();
                            result = this.worldMapMultiFloor.saveTo(this.outFile);
                        }
                        finally {
                            this.worldMapMultiFloor.endWrite();
                        }
                        if (result) break block23;
                        JOptionPane.showMessageDialog(this.mapFrame, "ファイルの保存に失敗しました。", "エラー", 0);
                        return false;
                    }
                    System.out.println("saved to " + this.outFile);
                    this.mapFrame.mapView.setMessage("saved to: " + this.outFile);
                    this.isDirty = false;
                    this.updateTitle();
                    return true;
                }
                return false;
            }
        }
        return false;
    }

    private void ReadInitialSettingFile() {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        try {
            String path = new File(".").getAbsoluteFile().getParent();
            DocumentBuilder builder = factory.newDocumentBuilder();
            File f2 = new File(this.INITIAL_SETTING_FILE);
            if (!f2.exists()) {
                return;
            }
            try {
                Document doc = builder.parse(f2);
                Element root = doc.getDocumentElement();
                NodeList children = root.getChildNodes();
                int i = 0;
                while (i < children.getLength()) {
                    Node child = children.item(i);
                    if (child instanceof Element) {
                        Element childElement = (Element)child;
                        if (childElement.getTagName().equals("ObjectMinHeightSize")) {
                            this.ObjectMinHeightSize = Double.parseDouble(childElement.getTextContent());
                            System.out.println("ObjectMinHeightSize:" + this.ObjectMinHeightSize);
                        }
                        if (childElement.getTagName().equals("ObjectMinWidthSize")) {
                            this.ObjectMinWidthSize = Double.parseDouble(childElement.getTextContent());
                            System.out.println("ObjectMinWidthSize:" + this.ObjectMinWidthSize);
                        }
                    }
                    ++i;
                }
            }
            catch (IOException | SAXException e) {
                e.printStackTrace();
            }
        }
        catch (ParserConfigurationException e) {
            e.printStackTrace();
        }
    }

    private void requestFileAndSetBackgroundImage_PDF(File f2) {
        try {
            String strScale;
            NumericCheck NC;
            RandomAccessFile raFile = new RandomAccessFile(f2, "r");
            FileChannel channel = raFile.getChannel();
            MappedByteBuffer buf = channel.map(FileChannel.MapMode.READ_ONLY, 0L, channel.size());
            PDFFile pdfFile = new PDFFile(buf);
            int pages = pdfFile.getNumPages();
            int readPage = 1;
            if (pages != 1) {
                String strReadPage = InputDialog.showDialog(this.mapFrame, "読み込むページを入力してください。", "全ページ数：" + pages, "1");
                if (strReadPage == null) {
                    return;
                }
                readPage = Integer.parseInt(strReadPage);
                if (readPage <= 0 || readPage > pages) {
                    return;
                }
            }
            PDFPage pdfPage = pdfFile.getPage(readPage);
            Image img = this.generateImageFromPdfPage(pdfPage);
            // [patch] removed sun.misc.Cleaner/DirectBuffer cleanup (encapsulated on JDK17)
            if (channel != null) {
                channel.close();
            }
            if (raFile != null) {
                raFile.close();
            }
            if (!(NC = new NumericCheck()).isNumericDouble(strScale = InputDialog.showDialog(this.mapFrame, "PDFの図面のスケールを入力してください。", "（例）１／１００の場合 １００    １／２００の場合 ２００", "100"))) {
                return;
            }
            double scale = Double.parseDouble(strScale);
            if (scale <= 0.0) {
                return;
            }
            double a = 0.35277777777777775;
            double width_pdf_mm = (double)img.getWidth(null) * a;
            double height_pdf_mm = (double)img.getHeight(null) * a;
            double width_real_mm = width_pdf_mm * scale;
            double height_real_mm = height_pdf_mm * scale;
            ImageObject objImage = new ImageObject();
            objImage.setImage((BufferedImage)img);
            Coord tl = new Coord(0.0, 0.0);
            Coord br = new Coord(width_real_mm, height_real_mm);
            try {
                this.map.startWrite();
                objImage.setBounds(tl, br);
            }
            finally {
                this.map.endWrite();
            }
            objImage.setBounds(tl, br);
            this.setBackgroundImage(objImage);
            this.setBounds(tl, br);
        }
        catch (Exception ex) {
            ex.printStackTrace();
        }
    }

    private Image generateImageFromPdfPage(PDFPage page) {
        Rectangle2D rect = page.getPageBox();
        float aspectRatio = page.getAspectRatio();
        int rotation = page.getRotation();
        int width = (int)rect.getWidth();
        int height = (int)rect.getHeight();
        if (rotation == 90) {
            width = (int)rect.getHeight();
            height = (int)rect.getWidth();
        }
        Image img = page.getImage(width, height, rect, null, true, true);
        return img;
    }

    private static String getSuffix(String fileName) {
        if (fileName == null) {
            return null;
        }
        int point = fileName.lastIndexOf(".");
        if (point != -1) {
            return fileName.substring(point + 1);
        }
        return fileName;
    }
}

