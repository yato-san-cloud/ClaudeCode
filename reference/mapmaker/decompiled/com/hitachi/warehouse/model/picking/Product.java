/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.picking;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.io.Serializable;
import javax.imageio.ImageIO;

public class Product
implements Serializable {
    private static final long serialVersionUID = -5188169990632519930L;
    public final String productCode;
    private String productCodeJAN13;
    private String productCodeITF;
    public final String productName;

    public String productCodeJAN() {
        return this.productCodeJAN13;
    }

    public void setProductCodeJAN(String code) {
        this.productCodeJAN13 = code;
    }

    public String productCodeITF() {
        return this.productCodeITF;
    }

    public void setProductCodeITF(String code) {
        this.productCodeITF = code;
    }

    public Product(String productCode, String productName) {
        this.productCode = productCode;
        this.productName = productName;
    }

    public BufferedImage getImage(File imgDir) {
        File imgFile;
        if (this.productCodeJAN13 != null && (imgFile = new File(imgDir, String.valueOf(this.productCodeJAN13) + ".png")).exists()) {
            BufferedImage img = null;
            try {
                img = ImageIO.read(imgFile);
            }
            catch (IOException e) {
                e.printStackTrace();
            }
            return img;
        }
        return null;
    }

    public String toString() {
        return String.valueOf(this.productName) + "[" + this.productCodeJAN13 + "]";
    }
}

